'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createAdapterRegistry, inspectSessionTarget } = require('../../scripts/lib/session-adapters/registry');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-session-routing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = path.join(root, 'storage');
  const sessionPath = path.join(storage, 'session', 'project', 'ses_native.json');
  const messagePath = path.join(storage, 'message', 'ses_native', 'msg_001.json');
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.mkdirSync(path.dirname(messagePath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify({
    id: 'ses_native', directory: root, title: 'Inspect a native session',
    time: { created: 1700000000000, updated: 1700000001000 },
  }));
  fs.writeFileSync(messagePath, JSON.stringify({
    role: 'assistant', modelID: 'native-model', providerID: 'native-provider',
  }));
  const options = {
    cwd: root,
    persistSnapshots: false,
    adapterOptions: { opencode: { resolveBranchImpl: () => null } },
  };
  return { root, sessionPath, options };
}

test('default registry selects the native adapter for an absolute OpenCode session file', t => {
  const { sessionPath, options } = fixture(t);
  assert.equal(createAdapterRegistry(options).select(sessionPath, options).id, 'opencode');
});

test('direct OpenCode file inspection returns native model and objective data', t => {
  const { sessionPath, options } = fixture(t);
  const snapshot = inspectSessionTarget(sessionPath, options);
  assert.equal(snapshot.adapterId, 'opencode');
  assert.equal(snapshot.session.id, 'ses_native');
  assert.equal(snapshot.workers[0].artifacts.model, 'native-model');
  assert.equal(snapshot.workers[0].intent.objective, 'Inspect a native session');
});

test('relative OpenCode files resolve against the requested working directory', t => {
  const { root, sessionPath, options } = fixture(t);
  const snapshot = inspectSessionTarget(path.relative(root, sessionPath), options);
  assert.equal(snapshot.adapterId, 'opencode');
  assert.equal(snapshot.session.id, 'ses_native');
});

test('session-inspect CLI accepts a direct OpenCode file without an adapter flag', t => {
  const { root, sessionPath } = fixture(t);
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '../../scripts/session-inspect.js'), sessionPath,
  ], {
    cwd: root,
    env: { ...process.env, HOME: root, USERPROFILE: root, ECC_AGENT_DATA_HOME: path.join(root, '.claude') },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.adapterId, 'opencode');
  assert.equal(snapshot.session.id, 'ses_native');
});

test('ordinary JSON plans retain the dmux fallback', t => {
  const { root, options } = fixture(t);
  const planPath = path.join(root, 'workflow.json');
  fs.writeFileSync(planPath, JSON.stringify({ sessionName: 'workflow' }));
  assert.equal(createAdapterRegistry(options).select(planPath, options).id, 'dmux-tmux');
});

test('explicit target types and adapter IDs retain precedence over filename inference', t => {
  const { sessionPath, options } = fixture(t);
  const registry = createAdapterRegistry(options);
  assert.equal(registry.select({ type: 'plan', value: sessionPath }, options).id, 'dmux-tmux');
  assert.equal(registry.select(sessionPath, { ...options, adapterId: 'dmux-tmux' }).id, 'dmux-tmux');
  assert.equal(registry.select({ type: 'opencode', value: sessionPath }, options).id, 'opencode');
});

test('native Codex files and Claude history files keep their existing adapters', t => {
  const { root, options } = fixture(t);
  const registry = createAdapterRegistry(options);
  const rollout = path.join(root, 'rollout-session.jsonl');
  const history = path.join(root, '2026-11-17-session.tmp');
  fs.writeFileSync(rollout, '{}\n');
  fs.writeFileSync(history, '# Session\n');
  assert.equal(registry.select(rollout, options).id, 'codex-worktree');
  assert.equal(registry.select(history, options).id, 'claude-history');
  assert.equal(registry.select('opencode:latest', options).id, 'opencode');
});

test('caller-supplied adapters keep their declared first-match order', () => {
  const adapters = [
    { id: 'first', canOpen: () => true },
    { id: 'second', canOpen: () => true },
  ];
  assert.equal(createAdapterRegistry({ adapters }).select('target').id, 'first');
});
