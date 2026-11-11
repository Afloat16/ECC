'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const trackerPath = require.resolve('../../scripts/lib/skill-evolution/tracker');
const tracker = require(trackerPath);

function execution(skillId) {
  return {
    skill_id: skillId, skill_version: '1', task_description: 'Skill invocation',
    outcome: 'success', recorded_at: '2026-11-11T12:00:00.000Z',
  };
}

function temporaryRuns(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-skill-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, runsFilePath: path.join(root, 'runs.jsonl') };
}

// Pause the first real writer after its retention read. The second writer either
// finishes (the former lost-update path) or reports lock contention. The parent
// then releases the first writer, without depending on scheduler timing.
const writerSource = String.raw`
  const fs = require('node:fs');
  const [trackerPath, runsFile, mode, progress, release] = process.argv.slice(1);
  const tracker = require(trackerPath);
  const originalRead = fs.readFileSync;
  const originalOpen = fs.openSync;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let paused = false;
  fs.readFileSync = function (file, ...args) {
    const bytes = originalRead.call(fs, file, ...args);
    if (mode === 'first' && file === runsFile && !paused) {
      paused = true;
      fs.writeFileSync(progress, 'paused');
      const deadline = performance.now() + 10000;
      while (!fs.existsSync(release)) {
        if (performance.now() >= deadline) throw new Error('Writer barrier timed out');
        Atomics.wait(sleeper, 0, 0, 10);
      }
    }
    return bytes;
  };
  fs.openSync = function (file, ...args) {
    try { return originalOpen.call(fs, file, ...args); }
    catch (error) {
      if (mode === 'second' && file === runsFile + '.ecc-state.lock' && error.code === 'EEXIST') {
        fs.writeFileSync(progress, 'waiting');
      }
      throw error;
    }
  };
  const result = tracker.recordSkillExecution({
    skill_id: 'writer-' + mode, skill_version: '1', task_description: 'Skill invocation',
    outcome: 'success', recorded_at: '2026-11-11T12:00:00.000Z',
  }, { runsFilePath: runsFile });
  fs.writeFileSync(progress, 'done');
  process.stdout.write(result.storage);
`;

function startWriter(root, runsFile, mode) {
  const child = spawn(process.execPath, [
    '-e', writerSource, trackerPath, runsFile, mode,
    path.join(root, mode), path.join(root, 'release'),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function waitForProgress(filePath) {
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(filePath)) {
    assert.ok(performance.now() < deadline, `Writer made no progress: ${filePath}`);
    await delay(10);
  }
}

test('concurrent writers preserve both successful runs at the retention cap', async t => {
  const { root, runsFilePath } = temporaryRuns(t);
  const seed = Array.from({ length: tracker.MAX_RUN_RECORDS }, (_, index) =>
    tracker.normalizeExecutionRecord(execution(`seed-${index}`)));
  fs.writeFileSync(runsFilePath, seed.map(record => JSON.stringify(record)).join('\n') + '\n');
  const writers = [];
  try {
    writers.push(startWriter(root, runsFilePath, 'first'));
    await waitForProgress(path.join(root, 'first'));
    writers.push(startWriter(root, runsFilePath, 'second'));
    await waitForProgress(path.join(root, 'second'));
    fs.writeFileSync(path.join(root, 'release'), 'release');
    for (const writer of writers) {
      const result = await writer.done;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, 'jsonl');
    }
    const records = tracker.readSkillExecutionRecords({ runsFilePath });
    assert.equal(records.length, tracker.MAX_RUN_RECORDS);
    assert.deepEqual(records.slice(-2).map(record => record.skill_id), ['writer-first', 'writer-second']);
    assert.equal(records[0].skill_id, 'seed-2');
    if (process.platform !== 'win32') assert.equal(fs.statSync(runsFilePath).mode & 0o777, tracker.RUNS_FILE_MODE);
  } finally {
    for (const writer of writers) {
      if (writer.child.exitCode === null) writer.child.kill();
    }
    await Promise.allSettled(writers.map(writer => writer.done));
  }
});

test('a busy lock rejects the write and preserves both the log and existing lock', t => {
  const { runsFilePath } = temporaryRuns(t);
  tracker.recordSkillExecution(execution('existing'), { runsFilePath });
  const before = fs.readFileSync(runsFilePath);
  const lockPath = `${runsFilePath}.ecc-state.lock`;
  fs.writeFileSync(lockPath, 'owned by another operation\n');
  assert.throws(() => tracker.recordSkillExecution(execution('blocked'), { runsFilePath }),
    error => error.code === 'STATE_STORE_BUSY');
  assert.deepEqual(fs.readFileSync(runsFilePath), before);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'owned by another operation\n');
  fs.unlinkSync(lockPath);
  tracker.recordSkillExecution(execution('retry'), { runsFilePath });
  assert.deepEqual(tracker.readSkillExecutionRecords({ runsFilePath }).map(record => record.skill_id), ['existing', 'retry']);
});

test('an append error releases the lock and preserves the primary error', t => {
  const { runsFilePath } = temporaryRuns(t);
  const failure = Object.assign(new Error('append failed'), { code: 'EIO' });
  t.mock.method(fs, 'appendFileSync', () => { throw failure; });
  assert.throws(() => tracker.recordSkillExecution(execution('failed'), { runsFilePath }), error => error === failure);
  assert.equal(fs.existsSync(`${runsFilePath}.ecc-state.lock`), false);
  t.mock.restoreAll();
  assert.equal(tracker.recordSkillExecution(execution('retry'), { runsFilePath }).storage, 'jsonl');
});

test('a best-effort retention error retains the accepted append and releases the lock', t => {
  const { runsFilePath } = temporaryRuns(t);
  tracker.recordSkillExecution(execution('existing'), { runsFilePath });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === runsFilePath) throw Object.assign(new Error('retention read failed'), { code: 'EIO' });
    return read.call(fs, file, ...args);
  });
  assert.equal(tracker.recordSkillExecution(execution('accepted'), { runsFilePath, maxRecords: 1 }).storage, 'jsonl');
  assert.equal(fs.existsSync(`${runsFilePath}.ecc-state.lock`), false);
  t.mock.restoreAll();
  assert.deepEqual(tracker.readSkillExecutionRecords({ runsFilePath }).map(record => record.skill_id), ['existing', 'accepted']);
  tracker.recordSkillExecution(execution('retry'), { runsFilePath, maxRecords: 1 });
  assert.deepEqual(tracker.readSkillExecutionRecords({ runsFilePath }).map(record => record.skill_id), ['retry']);
});
