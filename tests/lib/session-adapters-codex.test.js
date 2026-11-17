'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  createCodexWorktreeAdapter,
  parseCodexTarget,
  parseCodexRollout,
  isCodexRolloutFileTarget,
  findLatestRollout,
  findRolloutById
} = require('../../scripts/lib/session-adapters/codex-worktree');
const {
  normalizeCodexWorktreeSession,
  validateCanonicalSnapshot
} = require('../../scripts/lib/session-adapters/canonical-session');
const { createAdapterRegistry } = require('../../scripts/lib/session-adapters/registry');

console.log('=== Testing codex-worktree session adapter ===\n');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL - ${name}`);
    console.log(`        ${error && error.message}`);
  }
}

function writeRolloutFixture() {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-sessions-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-worktree-'));
  const dayDir = path.join(sessionsDir, '2026', '06', '02');
  fs.mkdirSync(dayDir, { recursive: true });

  const now = new Date().toISOString();
  const rolloutPath = path.join(dayDir, 'rollout-2026-06-02T03-01-58-019etest-codex-0001.jsonl');
  const lines = [
    { type: 'session_meta', timestamp: now, payload: {
      id: '019etest-codex-0001', timestamp: now, cwd: repoRoot,
      originator: 'Codex Desktop', cli_version: '0.136.0', source: 'vscode', model_provider: 'openai'
    } },
    { type: 'turn_context', timestamp: now, payload: { model: 'gpt-5.5-codex' } },
    { type: 'response_item', timestamp: now, payload: {
      type: 'message', role: 'user',
      content: [{ type: 'text', text: '# AGENTS.md instructions for /repo\n<cwd>/repo</cwd>' }]
    } },
    { type: 'response_item', timestamp: now, payload: {
      type: 'message', role: 'user',
      content: [{ type: 'text', text: 'continue our ecc 2.0 session and build the codex-worktree adapter' }]
    } }
  ];

  fs.writeFileSync(rolloutPath, lines.map(line => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return { sessionsDir, repoRoot, rolloutPath };
}

test('normalizeCodexWorktreeSession produces a valid ecc.session.v1 snapshot', () => {
  const snapshot = normalizeCodexWorktreeSession({
    sessionId: 'abc', sessionPath: '/tmp/r.jsonl', cwd: '/repo', branch: 'feat/x',
    objective: 'do the thing', model: 'gpt-5.5-codex', originator: 'Codex Desktop',
    cliVersion: '0.136.0', startedAt: '2026-06-02T03:01:58Z', recordCount: 4, active: true
  }, { type: 'codex-worktree', value: 'abc' });

  validateCanonicalSnapshot(snapshot);
  assert.strictEqual(snapshot.adapterId, 'codex-worktree');
  assert.strictEqual(snapshot.session.kind, 'codex-worktree');
  assert.strictEqual(snapshot.session.state, 'active');
  assert.strictEqual(snapshot.workers[0].runtime.kind, 'codex-session');
  assert.strictEqual(snapshot.workers[0].branch, 'feat/x');
  assert.strictEqual(snapshot.workers[0].artifacts.model, 'gpt-5.5-codex');
});

test('parseCodexTarget strips codex prefixes', () => {
  assert.strictEqual(parseCodexTarget('codex:latest'), 'latest');
  assert.strictEqual(parseCodexTarget('codex-worktree:019eabc'), '019eabc');
  assert.strictEqual(parseCodexTarget('/some/path.jsonl'), null);
});

test('adapter reads latest rollout, skips preamble, derives objective + model', () => {
  const { sessionsDir, repoRoot, rolloutPath } = writeRolloutFixture();
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-rec-'));

  assert.strictEqual(findLatestRollout(sessionsDir), rolloutPath);

  const adapter = createCodexWorktreeAdapter({
    sessionsDir, recordingDir, loadStateStoreImpl: () => null, resolveBranchImpl: () => null
  });
  const snapshot = adapter.open('codex:latest', { cwd: repoRoot }).getSnapshot();

  assert.strictEqual(snapshot.adapterId, 'codex-worktree');
  assert.strictEqual(snapshot.session.id, '019etest-codex-0001');
  assert.strictEqual(snapshot.session.state, 'active');
  assert.strictEqual(snapshot.workers.length, 1);
  assert.strictEqual(snapshot.workers[0].worktree, repoRoot);
  assert.strictEqual(snapshot.workers[0].runtime.command, 'codex');
  assert.strictEqual(snapshot.workers[0].runtime.active, true);
  assert.strictEqual(snapshot.workers[0].artifacts.model, 'gpt-5.5-codex');
  assert.strictEqual(
    snapshot.workers[0].intent.objective,
    'continue our ecc 2.0 session and build the codex-worktree adapter'
  );
  assert.strictEqual(snapshot.aggregates.workerCount, 1);
  assert.strictEqual(snapshot.aggregates.states.active, 1);
});

test('registry routes structured codex-worktree target and direct rollout path', () => {
  const { sessionsDir, repoRoot, rolloutPath } = writeRolloutFixture();
  const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-reg-'));

  const registry = createAdapterRegistry({
    recordingDir,
    loadStateStoreImpl: () => null,
    adapterOptions: { 'codex-worktree': { sessionsDir, resolveBranchImpl: () => null } }
  });

  const typed = registry.open({ type: 'codex-worktree', value: 'latest' }, { cwd: repoRoot }).getSnapshot();
  assert.strictEqual(typed.adapterId, 'codex-worktree');
  assert.strictEqual(typed.session.id, '019etest-codex-0001');

  const byPath = registry.open(rolloutPath, { cwd: repoRoot }).getSnapshot();
  assert.strictEqual(byPath.adapterId, 'codex-worktree');

  const listed = registry.listAdapters().map(a => a.id);
  assert.ok(listed.includes('codex-worktree'), 'registry lists codex-worktree adapter');
});


// --- branch/error coverage ---

function writeRollout(dir, name, lines) {
  const fp = require('path').join(dir, name);
  require('fs').writeFileSync(fp, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return fp;
}

test('parseCodexTarget handles non-string and unprefixed input', () => {
  assert.strictEqual(parseCodexTarget(null), null);
  assert.strictEqual(parseCodexTarget(42), null);
  assert.strictEqual(parseCodexTarget('/abs/path.jsonl'), null);
});

test('adapter throws clear errors for missing sessions and unknown ids', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-empty-'));
  const adapter = createCodexWorktreeAdapter({ sessionsDir, loadStateStoreImpl: () => null });
  assert.throws(() => adapter.open('codex:latest', { cwd: os.tmpdir() }).getSnapshot(), /No Codex rollout sessions found/);
  assert.throws(() => adapter.open('codex:nope-not-real', { cwd: os.tmpdir() }).getSnapshot(), /not found/);
  assert.throws(() => adapter.open('/not/a/rollout.txt', { cwd: os.tmpdir() }).getSnapshot(), /Unsupported Codex session target/);
});

test('findRolloutById + direct file target + isCodexRolloutFileTarget', () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-byid-'));
  const day = path.join(sessionsDir, '2026', '06', '02');
  fs.mkdirSync(day, { recursive: true });
  const now = new Date().toISOString();
  const fp = writeRollout(day, 'rollout-2026-06-02T03-00-00-019eUNIQUEID0001.jsonl', [
    { type: 'session_meta', timestamp: now, payload: { id: '019eUNIQUEID0001', cwd: sessionsDir } }
  ]);

  assert.strictEqual(findRolloutById(sessionsDir, '019eUNIQUEID0001'), fp);
  assert.ok(isCodexRolloutFileTarget(fp, os.tmpdir()));
  assert.ok(!isCodexRolloutFileTarget('not-a-file.jsonl', os.tmpdir()));

  const adapter = createCodexWorktreeAdapter({ sessionsDir, loadStateStoreImpl: () => null, resolveBranchImpl: () => null });
  const byId = adapter.open('codex:019eUNIQUEID0001', { cwd: os.tmpdir() }).getSnapshot();
  assert.strictEqual(byId.session.id, '019eUNIQUEID0001');
  const byFile = adapter.open(fp, { cwd: os.tmpdir() }).getSnapshot();
  assert.strictEqual(byFile.session.id, '019eUNIQUEID0001');
});

test('parseCodexRollout: model fallbacks, objective truncation, corrupt-line skip, mtime fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-parse-'));
  const longObjective = 'x'.repeat(400);
  const fp = path.join(dir, 'rollout-2026-06-02T03-00-00-019eMODELFALL0002.jsonl');
  // include a corrupt line, no turn_context (force meta.model_provider fallback), no timestamps (force mtime)
  fs.writeFileSync(fp, [
    JSON.stringify({ type: 'session_meta', payload: { id: '019eMODELFALL0002', cwd: dir, model_provider: 'openai' } }),
    '{ this is corrupt json',
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: longObjective }] } })
  ].join('\n') + '\n', 'utf8');

  const parsed = parseCodexRollout(fp, { resolveBranchImpl: () => null });
  assert.strictEqual(parsed.model, 'openai', 'falls back to model_provider when no turn_context/model');
  assert.ok(parsed.objective.endsWith('...'), 'long objective is truncated');
  assert.ok(parsed.objective.length <= 280);
  assert.strictEqual(parsed.active, true, 'no record timestamps => falls back to (recent) file mtime');
});

test('resolveGitBranch returns null when cwd is not a git repo (real path)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-nogit-'));
  const fp = path.join(dir, 'rollout-2026-06-02T03-00-00-019eNOGIT00003.jsonl');
  fs.writeFileSync(fp, JSON.stringify({ type: 'session_meta', payload: { id: '019eNOGIT00003', cwd: dir } }) + '\n', 'utf8');
  // no resolveBranchImpl => exercises the real execFileSync + catch path
  const parsed = parseCodexRollout(fp, {});
  assert.strictEqual(parsed.branch, null);
});


test('snapshot follows model changes appended to the same Codex rollout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-model-change-'));
  try {
    const rolloutPath = writeRollout(dir, 'rollout-model-change.jsonl', [
      { type: 'session_meta', payload: { id: 'model-change', model: 'metadata-model' } },
      { type: 'turn_context', payload: { model: 'initial-model' } },
    ]);
    const adapter = createCodexWorktreeAdapter({ sessionsDir: dir, persistSnapshots: false });
    const session = adapter.open(rolloutPath);
    assert.strictEqual(session.getSnapshot().workers[0].artifacts.model, 'initial-model');
    fs.appendFileSync(rolloutPath, JSON.stringify({
      type: 'turn_context', payload: { model: 'selected-model' },
    }) + '\n');
    assert.strictEqual(session.getSnapshot().workers[0].artifacts.model, 'selected-model');
    const contents = fs.readFileSync(rolloutPath, 'utf8');
    const parsed = parseCodexRollout(rolloutPath);
    assert.strictEqual(parsed.model, 'selected-model');
    assert.strictEqual(fs.readFileSync(rolloutPath, 'utf8'), contents);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('latest valid turn model survives trailing unrelated or incomplete records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-model-tail-'));
  try {
    const rolloutPath = writeRollout(dir, 'rollout-model-tail.jsonl', [
      { type: 'session_meta', payload: { id: 'model-tail', model: 'metadata-model' } },
      { type: 'turn_context', payload: { model: 'initial-model' } },
      { type: 'turn_context', payload: { model: 'selected-model' } },
      { type: 'response_item', payload: { model: 'unrelated-model' } },
      { type: 'turn_context', payload: { model: '' } },
      { type: 'turn_context', payload: { model: null } },
      { type: 'turn_context', payload: { model: 42 } },
      { type: 'turn_context', payload: null },
      null,
    ]);
    fs.appendFileSync(rolloutPath, '{"type":"turn_context","payload":');
    assert.strictEqual(parseCodexRollout(rolloutPath).model, 'selected-model');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [metadata, expected] of [
  [{ model: 'metadata-model', model_provider: 'provider-name' }, 'metadata-model'],
  [{ model_provider: 'provider-name' }, 'provider-name'],
  [{}, null],
]) {
  test('model metadata fallback remains available: ' + String(expected), () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-model-fallback-'));
    try {
      const rolloutPath = writeRollout(dir, 'rollout-model-fallback.jsonl', [
        { type: 'session_meta', payload: { id: 'model-fallback', ...metadata } },
        { type: 'turn_context', payload: { model: '' } },
        { type: 'turn_context', payload: { model: null } },
      ]);
      assert.strictEqual(parseCodexRollout(rolloutPath).model, expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('large rollouts do not retain the entire transcript while computing a snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-large-'));
  try {
    const rolloutPath = path.join(dir, 'rollout-large.jsonl');
    const descriptor = fs.openSync(rolloutPath, 'w');
    try {
      fs.writeSync(descriptor, JSON.stringify({ type: 'session_meta', payload: { id: 'large' } }) + '\n');
      const output = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(64 * 1024) } }) + '\n';
      for (let index = 0; index < 512; index += 1) fs.writeSync(descriptor, output);
      fs.writeSync(descriptor, JSON.stringify({ type: 'turn_context', payload: { model: 'tail-model' } }) + '\n');
    } finally {
      fs.closeSync(descriptor);
    }
    const script = `
      const { parseCodexRollout } = require(process.argv[1]);
      global.gc();
      const initialHeap = process.memoryUsage().heapUsed;
      let peakHeap = initialHeap;
      const parse = JSON.parse;
      JSON.parse = (...args) => {
        const value = parse(...args);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        return value;
      };
      const snapshot = parseCodexRollout(process.argv[2]);
      process.stdout.write(JSON.stringify({ snapshot, peakGrowth: peakHeap - initialHeap }));
    `;
    const result = spawnSync(process.execPath, ['--expose-gc', '-e', script,
      require.resolve('../../scripts/lib/session-adapters/codex-worktree'), rolloutPath], {
      encoding: 'utf8', timeout: 20000,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const { snapshot, peakGrowth } = JSON.parse(result.stdout);
    assert.strictEqual(snapshot.sessionId, 'large');
    assert.strictEqual(snapshot.recordCount, 514);
    assert.strictEqual(snapshot.model, 'tail-model');
    console.log(`    32 MiB rollout peak JS heap growth: ${peakGrowth} bytes`);
    assert.ok(peakGrowth < 24 * 1024 * 1024, `32 MiB rollout grew the JS heap by ${peakGrowth} bytes`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chunk boundaries preserve UTF-8, large records, trailing JSON and summary precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-chunks-'));
  try {
    const rolloutPath = path.join(dir, 'rollout-chunks.jsonl');
    const prefix = ' '.repeat(64 * 1024 - 2);
    const records = [
      { type: 'session_meta', payload: { id: 'first-meta', model: 'fallback-model' } },
      { type: 'session_meta', payload: { id: 'ignored-meta' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: '首个目标\u{1f642}' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'ignored objective' } },
      { type: 'response_item', payload: { output: '大'.repeat(64 * 1024) } },
      { type: 'turn_context', timestamp: new Date().toISOString(), payload: { model: 'latest-model' } },
      null,
    ];
    fs.writeFileSync(rolloutPath, prefix + '"\u{1f642}"\r\n' + records.map(JSON.stringify).join('\r\n'));
    const snapshot = parseCodexRollout(rolloutPath);
    assert.strictEqual(snapshot.sessionId, 'first-meta');
    assert.strictEqual(snapshot.objective, '首个目标\u{1f642}');
    assert.strictEqual(snapshot.model, 'latest-model');
    assert.strictEqual(snapshot.recordCount, 8);
    assert.strictEqual(snapshot.active, true);
    fs.appendFileSync(rolloutPath, '\n{"type":');
    assert.deepStrictEqual(parseCodexRollout(rolloutPath), snapshot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rollout records retain BOM and Unicode whitespace compatibility', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-bom-'));
  try {
    const rolloutPath = path.join(dir, 'rollout-bom.jsonl');
    fs.writeFileSync(rolloutPath, '\ufeff' + JSON.stringify({ type: 'session_meta', payload: { id: 'bom-session' } })
      + '\n\u00a0' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: 'preserved objective' } })
      + '\u2003\n\ufeff' + JSON.stringify({ type: 'turn_context', payload: { model: 'unicode-model' } }) + '\u00a0');
    const snapshot = parseCodexRollout(rolloutPath);
    assert.strictEqual(snapshot.sessionId, 'bom-session');
    assert.strictEqual(snapshot.objective, 'preserved objective');
    assert.strictEqual(snapshot.model, 'unicode-model');
    assert.strictEqual(snapshot.recordCount, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rollout scans finish at the original size even with short reads and concurrent appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-short-read-'));
  const originalRead = fs.readSync;
  try {
    const rolloutPath = writeRollout(dir, 'rollout-short.jsonl', [
      { type: 'session_meta', payload: { id: 'short-read' } },
      { type: 'turn_context', payload: { model: 'initial-model' } },
    ]);
    let appended = false;
    fs.readSync = (descriptor, buffer, offset, length, position) => {
      if (!appended) {
        appended = true;
        fs.appendFileSync(rolloutPath, JSON.stringify({ type: 'turn_context', payload: { model: 'appended-model' } }) + '\n');
      }
      return originalRead(descriptor, buffer, offset, Math.min(length, 7), position);
    };
    const snapshot = parseCodexRollout(rolloutPath);
    assert.strictEqual(snapshot.recordCount, 2);
    assert.strictEqual(snapshot.model, 'initial-model');
    fs.readSync = originalRead;
    assert.strictEqual(parseCodexRollout(rolloutPath).model, 'appended-model');
  } finally {
    fs.readSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rollout scans close their file descriptor after a read error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-read-error-'));
  const originalRead = fs.readSync;
  try {
    const rolloutPath = writeRollout(dir, 'rollout-error.jsonl', [{ type: 'session_meta', payload: { id: 'read-error' } }]);
    let descriptor;
    fs.readSync = fd => {
      descriptor = fd;
      throw new Error('injected read failure');
    };
    assert.throws(() => parseCodexRollout(rolloutPath), /injected read failure/);
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  } finally {
    fs.readSync = originalRead;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
