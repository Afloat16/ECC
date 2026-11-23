'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { acquireSettingsLock } = require('../../scripts/lib/install/claude-settings-lock');

const HOOK = path.resolve(__dirname, '../../scripts/hooks/ecc-metrics-bridge.js');
const DISPATCHER = path.resolve(__dirname, '../../scripts/hooks/posttooluse-dispatcher.js');
const event = (sessionId, file) => ({
  session_id: sessionId, tool_name: 'Write', tool_input: { file_path: file, content: file },
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture did not reach the expected phase');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(callback, command = [HOOK]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-metrics-transaction-'));
  const children = [];
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp,
    ECC_AGENT_DATA_HOME: path.join(temp, 'data'), CLAUDE_CONFIG_DIR: path.join(temp, 'data'),
    ECC_HOOK_PROFILE: 'minimal', ECC_DISABLED_HOOKS: '', ECC_DRY_RUN: '0' };
  delete env.ECC_HOOK_DEADLINE_MS;
  fs.mkdirSync(env.ECC_AGENT_DATA_HOME);
  const bridge = id => path.join(temp, `ecc-metrics-${id}.json`);
  const seed = id => fs.writeFileSync(bridge(id), JSON.stringify({
    session_id: id, tool_count: 0, files_modified_count: 0, files_modified: [], recent_tools: [],
  }));
  const start = (payload, prelude = '', extraEnv = {}) => {
    const args = [];
    if (prelude) {
      const preload = path.join(temp, `preload-${children.length}.cjs`);
      fs.writeFileSync(preload, prelude);
      args.push('--require', preload);
    }
    const input = JSON.stringify(payload);
    const child = spawn(process.execPath, [...args, ...command], {
      cwd: temp, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    const run = { child, done: false };
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderr += text; });
    run.completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        run.done = true;
        resolve({ code, signal, stdout, stderr, input, expectedStdout: command[0] === HOOK ? input : '' });
      });
    });
    children.push(run);
    child.stdin.end(input);
    return run;
  };
  try { return await callback({ temp, bridge, seed, start }); }
  finally {
    for (const { child, done } of children) if (!done) child.kill('SIGKILL');
    await Promise.allSettled(children.map(run => run.completion));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function assertPassThrough(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, result.expectedStdout);
  assert.equal(result.stderr, '');
}

function pauseAfterRead(bridge, ready, release) {
  return `
const fs = require('node:fs');
const read = fs.readFileSync;
let paused = false;
fs.readFileSync = function(file, ...args) {
  const result = read.call(this, file, ...args);
  if (!paused && String(file) === ${JSON.stringify(bridge)}) {
    paused = true;
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw new Error('fixture barrier expired');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return result;
};`;
}

async function checkConcurrentUpdates(command) {
  await fixture(async ({ temp, bridge, seed, start }) => {
    seed('shared');
    const ready = path.join(temp, 'ready');
    const release = path.join(temp, 'release');
    const contended = path.join(temp, 'contended');
    const first = start(event('shared', 'alpha.js'), pauseAfterRead(bridge('shared'), ready, release));
    await waitFor(() => fs.existsSync(ready));
    const second = start(event('shared', 'bravo.js'), `
const fs = require('node:fs');
const link = fs.linkSync;
fs.linkSync = function(source, target, ...args) {
  try { return link.call(this, source, target, ...args); }
  catch (error) {
    if (String(target) === ${JSON.stringify(bridge('shared') + '.ecc.lock')} && error.code === 'EEXIST') {
      fs.writeFileSync(${JSON.stringify(contended)}, 'waiting');
    }
    throw error;
  }
};`);
    // The old code finishes B while A holds its stale snapshot. The fixed code
    // reaches real lock contention before B can read. No scheduling sleep chooses the outcome.
    await waitFor(() => second.done || fs.existsSync(contended));
    fs.writeFileSync(release, 'continue');
    for (const result of await Promise.all([first.completion, second.completion])) assertPassThrough(result);
    const final = JSON.parse(fs.readFileSync(bridge('shared'), 'utf8'));
    assert.equal(final.tool_count, 2);
    assert.equal(final.files_modified_count, 2);
    assert.deepEqual(final.files_modified.sort(), ['alpha.js', 'bravo.js']);
    assert.equal(final.recent_tools.length, 2);
    assert.notEqual(final.recent_tools[0].hash, final.recent_tools[1].hash);
    assert.equal(fs.existsSync(bridge('shared') + '.ecc.lock'), false);
  }, command);
}

for (const [entrypoint, command] of [['hook', [HOOK]], ['registered sync dispatcher', [DISPATCHER, 'sync']]]) {
  test(`two completed ${entrypoint} processes retain both increments, modified files and tool entries`,
    () => checkConcurrentUpdates(command));
}

test('a held session does not delay another session update', async () => {
  await fixture(async ({ temp, bridge, seed, start }) => {
    seed('held'); seed('other');
    const ready = path.join(temp, 'ready'); const release = path.join(temp, 'release');
    const first = start(event('held', 'alpha.js'), pauseAfterRead(bridge('held'), ready, release));
    await waitFor(() => fs.existsSync(ready));
    assertPassThrough(await start(event('other', 'bravo.js')).completion);
    assert.equal(first.done, false);
    assert.equal(JSON.parse(fs.readFileSync(bridge('other'), 'utf8')).tool_count, 1);
    fs.writeFileSync(release, 'continue');
    assertPassThrough(await first.completion);
  });
});

test('a live lock timeout preserves the committed bridge and permits retry after release', async () => {
  await fixture(async ({ bridge, seed, start }) => {
    seed('busy');
    const before = fs.readFileSync(bridge('busy'));
    const release = acquireSettingsLock(bridge('busy'));
    try {
      // Set the deadline after child startup so this exercises contention, not spawn latency.
      const result = await start(event('busy', 'waiting.js'),
        'process.env.ECC_HOOK_DEADLINE_MS = String(Date.now() + 200);').completion;
      assertPassThrough(result);
      assert.deepEqual(fs.readFileSync(bridge('busy')), before);
    } finally { release(); }
    assertPassThrough(await start(event('busy', 'retry.js')).completion);
    const final = JSON.parse(fs.readFileSync(bridge('busy'), 'utf8'));
    assert.equal(final.tool_count, 1);
    assert.deepEqual(final.files_modified, ['retry.js']);
  });
});

test('expired or invalid inherited deadlines leave metrics unchanged and pass input through', async () => {
  await fixture(async ({ bridge, seed, start }) => {
    seed('deadline');
    const before = fs.readFileSync(bridge('deadline'));
    for (const deadline of ['1', 'not-a-deadline']) {
      assertPassThrough(await start(event('deadline', 'skipped.js'), '', { ECC_HOOK_DEADLINE_MS: deadline }).completion);
      assert.deepEqual(fs.readFileSync(bridge('deadline')), before);
      assert.equal(fs.existsSync(bridge('deadline') + '.ecc.lock'), false);
    }
  });
});

test('a terminated holder leaves committed metrics intact and its next update recovers', async () => {
  await fixture(async ({ temp, bridge, seed, start }) => {
    seed('terminated');
    const ready = path.join(temp, 'ready'); const release = path.join(temp, 'release');
    const first = start(event('terminated', 'unfinished.js'), pauseAfterRead(bridge('terminated'), ready, release));
    await waitFor(() => fs.existsSync(ready));
    first.child.kill('SIGKILL');
    await first.completion;
    assert.equal(JSON.parse(fs.readFileSync(bridge('terminated'), 'utf8')).tool_count, 0);
    assertPassThrough(await start(event('terminated', 'finished.js')).completion);
    const final = JSON.parse(fs.readFileSync(bridge('terminated'), 'utf8'));
    assert.equal(final.tool_count, 1);
    assert.deepEqual(final.files_modified, ['finished.js']);
    assert.equal(fs.existsSync(bridge('terminated') + '.ecc.lock'), false);
  });
});

test('failed atomic publication releases the lock without replacing committed metrics', async () => {
  await fixture(async ({ bridge, seed, start }) => {
    seed('failure');
    const before = fs.readFileSync(bridge('failure'));
    assertPassThrough(await start(event('failure', 'failed.js'), `
const fs = require('node:fs');
const rename = fs.renameSync;
fs.renameSync = function(source, target, ...args) {
  if (String(target) === ${JSON.stringify(bridge('failure'))}) {
    throw Object.assign(new Error('fixture publication error'), { code: 'EIO' });
  }
  return rename.call(this, source, target, ...args);
};`).completion);
    assert.deepEqual(fs.readFileSync(bridge('failure')), before);
    assert.equal(fs.existsSync(bridge('failure') + '.ecc.lock'), false);
    assertPassThrough(await start(event('failure', 'retry.js')).completion);
    assert.equal(JSON.parse(fs.readFileSync(bridge('failure'), 'utf8')).tool_count, 1);
  });
});
