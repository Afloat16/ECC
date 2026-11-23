'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  createCodexWorktreeAdapter, parseCodexRollout,
} = require('../../scripts/lib/session-adapters/codex-worktree');
const { normalizeCodexWorktreeSession } = require('../../scripts/lib/session-adapters/canonical-session');

const repository = path.resolve(__dirname, '../..');
const timestamp = '2026-01-01T00:00:00.000Z';
const metadata = { type: 'session_meta', payload: {
  id: 'stream-fixture', timestamp, model: 'metadata-model',
  originator: 'codex_cli_rs', cli_version: 'fixture',
} };
const user = text => ({ type: 'response_item', payload: {
  type: 'message', role: 'user', content: [{ type: 'input_text', text }],
} });
const turn = model => ({ type: 'turn_context', payload: { model } });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-rollout-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, rollout: path.join(root, 'rollout-stream-fixture.jsonl') };
}

function writeRecords(file, records, ending = '\n') {
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join(ending) + ending);
}

function expectedSession(rollout, overrides = {}) {
  return {
    sessionId: 'stream-fixture', sessionPath: rollout, cwd: null, branch: null,
    objective: '', model: 'metadata-model', originator: 'codex_cli_rs',
    cliVersion: 'fixture', startedAt: timestamp, recordCount: 1, active: false,
    ...overrides,
  };
}

test('public CLI inspects a long rollout within a 48 MiB JavaScript heap', t => {
  const { root, rollout } = fixture(t);
  writeRecords(rollout, [metadata, user('Inspect the build output.')]);
  const record = JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'fixture-call', output: 'Build output '.repeat(341),
  } }) + '\n';
  const batch = record.repeat(100);
  for (let index = 0; index < 6000; index += 100) fs.appendFileSync(rollout, batch);
  fs.appendFileSync(rollout, `${JSON.stringify({ ...turn('selected-model'), timestamp })}\n`);
  const resultPath = path.join(root, 'snapshot.json');
  const child = spawnSync(process.execPath, [
    '--max-old-space-size=48', path.join(repository, 'scripts/session-inspect.js'),
    rollout, '--write', resultPath,
  ], {
    cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ECC_SESSION_RECORDING_DIR: path.join(root, 'recordings') },
  });
  assert.equal(child.status, 0, child.stderr);
  const expected = normalizeCodexWorktreeSession(expectedSession(rollout, {
    objective: 'Inspect the build output.', model: 'selected-model', recordCount: 6003,
  }), { type: 'codex-rollout-file', value: rollout });
  assert.deepEqual(JSON.parse(child.stdout), expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, 'utf8')), expected);
  assert.ok(fs.readdirSync(path.join(root, 'recordings')).length > 0);
});

test('preserves first metadata and objective, last valid model/time, and every parsed record', t => {
  const { rollout } = fixture(t);
  const records = [
    null, false, 7, ['array'], metadata,
    { type: 'session_meta', payload: { id: 'later-meta', model: 'later-meta-model' } },
    user('# injected context'), user('019e52db-abcd-1234-9abc-123456789abcInspect this change.'),
    user('A later request'), turn('earlier-model'), turn('selected-model'), turn(''), turn(null),
    { timestamp }, { timestamp: 'invalid' },
  ];
  writeRecords(rollout, records);
  fs.appendFileSync(rollout, '\n not-json\n  \t\r\n{"partial":');
  assert.deepEqual(parseCodexRollout(rollout), expectedSession(rollout, {
    objective: 'Inspect this change.', model: 'selected-model', recordCount: records.length,
  }));
});

test('a first session metadata record with no payload still wins', t => {
  const { rollout } = fixture(t);
  writeRecords(rollout, [{ type: 'session_meta', payload: null }, metadata, { timestamp }]);
  assert.deepEqual(parseCodexRollout(rollout), expectedSession(rollout, {
    sessionId: path.basename(rollout, '.jsonl'), model: null, originator: null,
    cliVersion: null, startedAt: null, recordCount: 3,
  }));
});

for (const readLimit of [null, 17]) {
  test(`decodes split UTF-8, CRLF and a long final record with read size ${readLimit || 'native'}`, t => {
    const { rollout } = fixture(t);
    const objective = 'নিরাপদ \u{1f6e0}\ufe0f changes';
    const records = [metadata, user(objective), { timestamp }, {
      ...turn('model-নিরাপদ-\u{1f6e0}\ufe0f'), unused: 'a'.repeat(65510) + '\u{1f6e0}\ufe0f'.repeat(25000),
    }];
    fs.writeFileSync(rollout, records.map(record => JSON.stringify(record)).join('\r\n'));
    const readSync = fs.readSync;
    let readCalls = 0;
    fs.readSync = function (fd, buffer, offset, length, position) {
      readCalls += 1;
      return readSync(fd, buffer, offset, readLimit ? Math.min(length, readLimit) : length, position);
    };
    try {
      assert.deepEqual(parseCodexRollout(rollout), expectedSession(rollout, {
        objective, model: 'model-নিরাপদ-\u{1f6e0}\ufe0f', recordCount: records.length,
      }));
      // readFileSync handles its own reads on the original implementation;
      // an incremental reader must tolerate the forced short reads here.
      if (readLimit && readCalls > 0) assert.ok(readCalls > 100);
    } finally {
      fs.readSync = readSync;
    }
  });
}

test('refreshing one adapter handle rereads appended and completed records', t => {
  const { root, rollout } = fixture(t);
  writeRecords(rollout, [metadata, user('Keep the first objective'), { timestamp }]);
  const adapter = createCodexWorktreeAdapter({ persistSnapshots: false });
  const handle = adapter.open(rollout, { cwd: root });
  const first = handle.getSnapshot();
  fs.appendFileSync(rollout, '{"type":"turn_context","payload":');
  assert.deepEqual(handle.getSnapshot(), first);
  fs.appendFileSync(rollout, '{"model":"appended-model"}}\n');
  const next = handle.getSnapshot();
  assert.equal(next.workers[0].artifacts.recordCount, 4);
  assert.equal(next.workers[0].artifacts.model, 'appended-model');
  assert.deepEqual(next.workers[0].intent, first.workers[0].intent);
});

test('empty and timestamp-free rollouts retain mtime and metadata fallbacks', t => {
  const { rollout } = fixture(t);
  fs.writeFileSync(rollout, '\n \t\r\nnot-json');
  fs.utimesSync(rollout, new Date(timestamp), new Date(timestamp));
  assert.deepEqual(parseCodexRollout(rollout), expectedSession(rollout, {
    sessionId: path.basename(rollout, '.jsonl'), model: null, originator: null,
    cliVersion: null, startedAt: null, recordCount: 0,
  }));
  writeRecords(rollout, [{ type: 'session_meta', payload: { model_provider: 'provider-fallback' } }]);
  assert.equal(parseCodexRollout(rollout).model, 'provider-fallback');
  assert.equal(parseCodexRollout(rollout).active, true);
});

test('read errors propagate and close an opened rollout descriptor', t => {
  const { rollout } = fixture(t);
  writeRecords(rollout, [metadata, user('a'.repeat(200000))]);
  const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, readFile: fs.readFileSync };
  let descriptor;
  let closed = false;
  let reads = 0;
  const failure = Object.assign(new Error('injected rollout read failure'), { code: 'EIO' });
  fs.openSync = function (file, ...args) {
    const fd = original.open(file, ...args);
    if (file === rollout) descriptor = fd;
    return fd;
  };
  fs.closeSync = function (fd) {
    if (fd === descriptor) closed = true;
    return original.close(fd);
  };
  fs.readSync = function (fd, ...args) {
    if (fd === descriptor && reads++ > 0) throw failure;
    return original.read(fd, ...args);
  };
  fs.readFileSync = function (file, ...args) {
    if (file === rollout) throw failure;
    return original.readFile(file, ...args);
  };
  try {
    assert.throws(() => parseCodexRollout(rollout), { code: 'EIO' });
    if (descriptor !== undefined) assert.equal(closed, true);
  } finally {
    fs.openSync = original.open;
    fs.closeSync = original.close;
    fs.readSync = original.read;
    fs.readFileSync = original.readFile;
  }
  assert.throws(() => parseCodexRollout(`${rollout}.missing`), { code: 'ENOENT' });
});
