'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getFallbackSessionRecordingPath,
  normalizeDmuxSnapshot,
  persistCanonicalSnapshot
} = require('../../scripts/lib/session-adapters/canonical-session');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-recording-identities-'));
  const recordingDir = path.join(fixtureRoot, 'recordings');
  fs.mkdirSync(recordingDir);
  try {
    fn({ recordingDir, loadStateStoreImpl: () => null });
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.stack}`);
    failed++;
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function snapshot(sessionName, adapterId = 'dmux-tmux', active = true) {
  return {
    ...normalizeDmuxSnapshot({ sessionName, sessionActive: active, workerCount: 0, workers: [] }, {
      type: 'tmux-session', value: sessionName
    }),
    adapterId
  };
}

function readRecording(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

for (const names of [
  ['research team', 'research_team'],
  ['中文甲', '中文乙', 'unknown'],
  ['team', ' team ', '_team_'],
  ['task/name', 'task:name', 'task_name']
]) {
  test(`real dmux snapshots keep independent histories for ${names.join(' / ')}`, options => {
    const paths = names.map(name => persistCanonicalSnapshot(snapshot(name), options).path);
    assert.strictEqual(new Set(paths).size, names.length);
    names.forEach((name, index) => {
      const first = readRecording(paths[index]);
      assert.strictEqual(first.sessionId, name);
      assert.deepStrictEqual(first.history.map(entry => entry.snapshot.session.id), [name]);
      const next = persistCanonicalSnapshot(snapshot(name, 'dmux-tmux', false), options);
      assert.strictEqual(next.path, paths[index]);
      assert.deepStrictEqual(readRecording(next.path).history.map(entry => entry.snapshot.session.id), [name, name]);
    });
  });
}

test('adapter namespaces remain distinct after normalization', options => {
  const first = persistCanonicalSnapshot(snapshot('session', 'adapter team'), options);
  const second = persistCanonicalSnapshot(snapshot('session', 'adapter_team'), options);
  assert.notStrictEqual(first.path, second.path);
  assert.strictEqual(readRecording(first.path).adapterId, 'adapter team');
  assert.strictEqual(readRecording(second.path).adapterId, 'adapter_team');
});

test('existing safe ASCII adapter and session paths are unchanged', options => {
  for (const name of ['session-123', 'alpha_beta', 'team.alpha']) {
    assert.strictEqual(getFallbackSessionRecordingPath(snapshot(name), options), path.join(options.recordingDir, 'dmux-tmux', `${name}.json`));
  }
});

test('an identity copied from a generated filename cannot collide with it', options => {
  const unsafe = snapshot('research team');
  const first = persistCanonicalSnapshot(unsafe, options);
  const filenameAsId = path.basename(first.path, '.json');
  const second = persistCanonicalSnapshot(snapshot(filenameAsId), options);
  assert.notStrictEqual(second.path, first.path);
  assert.strictEqual(readRecording(first.path).sessionId, unsafe.session.id);
  assert.strictEqual(readRecording(second.path).sessionId, filenameAsId);
});

test('unchanged snapshots retain one history entry at the new stable path', options => {
  const value = snapshot('中文会话');
  const first = persistCanonicalSnapshot(value, options);
  const second = persistCanonicalSnapshot(value, options);
  assert.strictEqual(first.path, second.path);
  assert.strictEqual(readRecording(first.path).history.length, 1);
});

function seedLegacy(options, value, history = [value]) {
  const legacy = path.join(options.recordingDir, 'dmux-tmux', 'research_team.json');
  const recordedAt = '2026-01-01T00:00:00.000Z';
  const data = {
    schemaVersion: 'ecc.session.recording.v1',
    adapterId: value.adapterId,
    sessionId: value.session.id,
    createdAt: recordedAt,
    updatedAt: recordedAt,
    latest: value,
    history: history.map(item => ({ recordedAt, snapshot: item }))
  };
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  const bytes = `${JSON.stringify(data)}\n`;
  fs.writeFileSync(legacy, bytes);
  return { path: legacy, bytes, data };
}

test('coherent legacy history is inherited without modifying the legacy file', options => {
  const first = snapshot('research team');
  const legacy = seedLegacy(options, first);
  if (process.platform !== 'win32') fs.chmodSync(legacy.path, 0o600);
  const next = snapshot('research team', 'dmux-tmux', false);
  const written = persistCanonicalSnapshot(next, options);
  assert.notStrictEqual(written.path, legacy.path);
  assert.strictEqual(fs.readFileSync(legacy.path, 'utf8'), legacy.bytes);
  const current = readRecording(written.path);
  assert.strictEqual(current.createdAt, legacy.data.createdAt);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(written.path).mode & 0o077, 0);
  assert.deepStrictEqual(current.history.map(entry => entry.snapshot), [first, next]);
  persistCanonicalSnapshot(next, options);
  assert.strictEqual(readRecording(written.path).history.length, 2);
});

test('a legacy file belonging to another session is neither inherited nor replaced', options => {
  const legacy = seedLegacy(options, snapshot('research_team'));
  const value = snapshot('research team');
  const written = persistCanonicalSnapshot(value, options);
  assert.strictEqual(fs.readFileSync(legacy.path, 'utf8'), legacy.bytes);
  assert.deepStrictEqual(readRecording(written.path).history.map(entry => entry.snapshot), [value]);
});

test('mixed legacy histories are preserved separately and never imported', options => {
  const value = snapshot('research team');
  const legacy = seedLegacy(options, value, [snapshot('research_team'), value]);
  const written = persistCanonicalSnapshot(value, options);
  assert.strictEqual(fs.readFileSync(legacy.path, 'utf8'), legacy.bytes);
  assert.deepStrictEqual(readRecording(written.path).history.map(entry => entry.snapshot), [value]);
});

test('a foreign recording already at the destination is preserved on failure', options => {
  const foreign = seedLegacy(options, snapshot('research team'));
  assert.throws(() => persistCanonicalSnapshot(snapshot('research_team'), options), /identity/);
  assert.strictEqual(fs.readFileSync(foreign.path, 'utf8'), foreign.bytes);
});

test('failed migration preserves the legacy history and publishes no partial copy', options => {
  const value = snapshot('research team');
  const legacy = seedLegacy(options, value);
  const destination = getFallbackSessionRecordingPath(value, options);
  const originalWrite = fs.writeFileSync;
  const failure = Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
  fs.writeFileSync = descriptor => {
    assert.strictEqual(typeof descriptor, 'number');
    fs.writeSync(descriptor, '{');
    throw failure;
  };
  try {
    assert.throws(() => persistCanonicalSnapshot(value, options), error => error === failure);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.strictEqual(fs.readFileSync(legacy.path, 'utf8'), legacy.bytes);
  assert.strictEqual(fs.existsSync(destination), false);
});

test('dot adapter identities remain inside the configured recording directory', options => {
  for (const adapterId of ['.', '..']) {
    const written = persistCanonicalSnapshot(snapshot('session', adapterId), options);
    const relative = path.relative(options.recordingDir, written.path);
    assert.strictEqual(path.isAbsolute(relative), false);
    assert.strictEqual(relative.split(path.sep).length, 2);
    assert.notStrictEqual(relative.split(path.sep)[0], '..');
    assert.strictEqual(readRecording(written.path).adapterId, adapterId);
  }
});

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
