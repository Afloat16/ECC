'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { resolveSnapshotTarget } = require('../../scripts/lib/orchestration-session');
const { createDmuxTmuxAdapter } = require('../../scripts/lib/session-adapters/dmux-tmux');
const { createAdapterRegistry } = require('../../scripts/lib/session-adapters/registry');

const scripts = path.join(__dirname, '..', '..', 'scripts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-orchestration-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(script, args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [path.join(scripts, script), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ECC_SESSION_RECORDING_DIR: path.join(cwd, 'recordings'), ...env }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writePlan(cwd, options = {}) {
  const planPath = path.join(cwd, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    sessionName: 'Task Audit',
    repoRoot: cwd,
    launcherCommand: 'echo worker',
    workers: [{ name: 'Docs A', task: 'Inspect the documented workflow.' }],
    ...options
  }));
  run('orchestrate-worktrees.js', [planPath, '--write-only'], cwd);
  return planPath;
}

function assertWorker(snapshot, sessionName, workerName = 'docs-a') {
  assert.equal(snapshot.adapterId, 'dmux-tmux');
  assert.equal(snapshot.session.id, sessionName);
  assert.equal(snapshot.workers.length, 1);
  assert.equal(snapshot.workers[0].id, workerName);
  assert.equal(snapshot.workers[0].intent.objective, 'Inspect the documented workflow.');
}

function writeLegacyWorker(root, sessionName, workerName = 'legacy') {
  const workerDir = path.join(root, '.claude', 'orchestration', sessionName, workerName);
  fs.mkdirSync(workerDir, { recursive: true });
  fs.writeFileSync(path.join(workerDir, 'task.md'), '## Objective\nInspect the documented workflow.\n');
  fs.writeFileSync(path.join(workerDir, 'status.md'), '- State: completed\n');
}

test('status reads the worker written by a plan with a display name', t => {
  const root = fixture(t);
  const planPath = writePlan(root);
  assert.ok(fs.existsSync(path.join(root, '.orchestration', 'task-audit', 'docs-a', 'task.md')));
  const snapshot = JSON.parse(run('orchestration-status.js', [planPath], root));
  assertWorker(snapshot, 'task-audit');
  assert.equal(snapshot.session.sourceTarget.type, 'plan');
});

for (const name of ['Task Audit', 'task-audit']) {
  test(`status finds the default coordination directory by name: ${name}`, t => {
    const root = fixture(t);
    writePlan(root);
    const snapshot = JSON.parse(run('orchestration-status.js', [name], root));
    assertWorker(snapshot, 'task-audit');
    assert.equal(snapshot.session.sourceTarget.type, 'session');
    assert.equal(snapshot.session.sourceTarget.value, name);
  });
}

test('session-inspect automatically selects a session written in the default directory', t => {
  const root = fixture(t);
  writePlan(root);
  const snapshot = JSON.parse(run('session-inspect.js', ['task-audit'], root));
  assertWorker(snapshot, 'task-audit');
});

test('status derives an omitted session name from the repository name', t => {
  const root = fixture(t);
  const repoRoot = path.join(root, 'Example Project');
  fs.mkdirSync(repoRoot);
  const planPath = writePlan(root, { sessionName: undefined, repoRoot });
  const snapshot = JSON.parse(run('orchestration-status.js', [planPath], root));
  assertWorker(snapshot, 'example-project');
});

test('status uses the planner fallback when a name contains no slug characters', t => {
  const root = fixture(t);
  const planPath = writePlan(root, { sessionName: '!!!' });
  const snapshot = JSON.parse(run('orchestration-status.js', [planPath], root));
  assertWorker(snapshot, 'session');
});

test('plan lookup honors custom coordination roots and the supplied cwd for relative paths', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'Example Project'));
  const planPath = writePlan(root, {
    repoRoot: 'Example Project',
    coordinationRoot: 'shared snapshots'
  });
  const target = resolveSnapshotTarget(planPath, root);
  assert.equal(target.repoRoot, path.join(root, 'Example Project'));
  assert.equal(target.coordinationDir, path.join(root, 'shared snapshots', 'task-audit'));
  const snapshot = JSON.parse(run('orchestration-status.js', [planPath], root));
  assertWorker(snapshot, 'task-audit');
});

test('existing legacy session names retain their exact spelling and remain auto-detectable', t => {
  const root = fixture(t);
  writeLegacyWorker(root, 'Existing Session');
  const snapshot = JSON.parse(run('session-inspect.js', ['Existing Session'], root));
  assertWorker(snapshot, 'Existing Session', 'legacy');
  assert.equal(resolveSnapshotTarget('Existing Session', root).coordinationDir,
    path.join(root, '.claude', 'orchestration', 'Existing Session'));
});

test('a current default session takes precedence over a same-name legacy session', t => {
  const root = fixture(t);
  writePlan(root);
  writeLegacyWorker(root, 'task-audit');
  const snapshot = JSON.parse(run('session-inspect.js', ['task-audit'], root));
  assertWorker(snapshot, 'task-audit');
});

test('a file at the modern directory path does not hide an existing legacy session', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.orchestration'));
  fs.writeFileSync(path.join(root, '.orchestration', 'task-audit'), 'not a session directory');
  writeLegacyWorker(root, 'Task Audit');
  const snapshot = JSON.parse(run('session-inspect.js', ['Task Audit'], root));
  assertWorker(snapshot, 'Task Audit', 'legacy');
});

test('missing named sessions retain the legacy fallback without claiming adapter support', t => {
  const root = fixture(t);
  const target = resolveSnapshotTarget('missing-session', root);
  assert.equal(target.sessionName, 'missing-session');
  assert.equal(target.coordinationDir, path.join(root, '.claude', 'orchestration', 'missing-session'));
  assert.equal(createDmuxTmuxAdapter().canOpen('missing-session', { cwd: root }), false);
});

test('automatic adapter detection rejects empty and non-string targets', t => {
  const root = fixture(t);
  const adapter = createDmuxTmuxAdapter();
  for (const target of ['', null, undefined, {}]) {
    assert.equal(adapter.canOpen(target, { cwd: root }), false);
  }
});

for (const target of ['codex:latest', 'codex-worktree:latest', 'opencode:latest']) {
  test(`a same-slug orchestration session does not claim the explicit target ${target}`, t => {
    const root = fixture(t);
    writePlan(root, { sessionName: target });
    const adapterId = target.startsWith('opencode:') ? 'opencode' : 'codex-worktree';
    const registry = createAdapterRegistry({ persistSnapshots: false });
    assert.equal(registry.select(target, { cwd: root }).id, adapterId);
    assert.equal(registry.select(target, { cwd: root, adapterId: 'dmux-tmux' }).id, 'dmux-tmux');

    const sessionsDir = path.join(root, 'harness-sessions');
    fs.mkdirSync(sessionsDir);
    let env;
    if (adapterId === 'codex-worktree') {
      fs.writeFileSync(path.join(sessionsDir, 'rollout-fixture.jsonl'), JSON.stringify({
        type: 'session_meta', payload: { id: 'codex-fixture' }
      }) + '\n');
      env = { CODEX_SESSIONS_DIR: sessionsDir };
    } else {
      fs.mkdirSync(path.join(sessionsDir, 'session', 'project'), { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, 'session', 'project', 'ses_fixture.json'),
        JSON.stringify({ id: 'ses_fixture', directory: root, title: 'Harness fixture' }));
      env = { OPENCODE_STORAGE_DIR: sessionsDir };
    }
    const snapshot = JSON.parse(run('session-inspect.js', [target], root, env));
    assert.equal(snapshot.adapterId, adapterId);
    assert.equal(snapshot.session.id, adapterId === 'codex-worktree' ? 'codex-fixture' : 'ses_fixture');
    assertWorker(JSON.parse(run('orchestration-status.js', [target], root)), target.replace(':', '-'));
  });
}

test('a same-slug orchestration session does not claim an existing Codex rollout file', t => {
  const root = fixture(t);
  const target = 'rollout-fixture.jsonl';
  writePlan(root, { sessionName: target });
  fs.writeFileSync(path.join(root, target), JSON.stringify({
    type: 'session_meta', payload: { id: 'rollout-file-fixture' }
  }) + '\n');
  const snapshot = JSON.parse(run('session-inspect.js', [target], root));
  assert.equal(snapshot.adapterId, 'codex-worktree');
  assert.equal(snapshot.session.id, 'rollout-file-fixture');
});
