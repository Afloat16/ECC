'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { agentPriority, rightOfWay } = require('../../scripts/lib/agent-proximity/distance');
const { scanAirspace, buildProximityTriggers } = require('../../scripts/lib/agent-proximity');
const { buildProximitySnapshot, createProximityDispatcher, runProximityTick } = require('../../scripts/lib/control-pane/proximity');
const { buildControlPlaneView, EVENT_KINDS } = require('../../scripts/lib/control-pane/control-plane-view');

const NOW = Date.parse('2026-11-23T00:00:00.000Z');
const START = '2026-01-01T00:00:00.000Z';
const EXPECTED = { hold: 'alpha', steer: 'bravo' };
const agent = (agentId, extra = {}) => ({
  agentId, startedAt: START, files: [{ path: 'shared.js', lines: [[1, 1]], weight: 1 }], ...extra,
});

async function withClock(step, callback) {
  const original = Date.now;
  let now = NOW;
  Date.now = () => {
    const sampled = now;
    now += step;
    return sampled;
  };
  try { return await callback(); }
  finally { Date.now = original; }
}

test('equal start times keep the ID tiebreak across clock ticks and argument order', async () => {
  for (const step of [1, -1, 1000, -1000]) {
    await withClock(step, () => {
      assert.deepEqual(rightOfWay(agent('alpha'), agent('bravo')), EXPECTED);
      assert.deepEqual(rightOfWay(agent('bravo'), agent('alpha')), EXPECTED);
    });
  }
});

test('clock changes cannot overturn the earlier start when progress is equal', async () => {
  const earlier = agent('bravo');
  const later = agent('alpha', { startedAt: '2026-01-01T00:00:00.001Z' });
  for (const step of [100, -100]) {
    await withClock(step, () => {
      assert.deepEqual(rightOfWay(earlier, later), { hold: 'bravo', steer: 'alpha' });
      assert.deepEqual(rightOfWay(later, earlier), { hold: 'bravo', steer: 'alpha' });
    });
  }
});

test('progress still wins before age and the ID tiebreak', async () => {
  const moreWork = agent('bravo', { startedAt: '2026-02-01T00:00:00.000Z',
    files: [{ path: 'shared.js', weight: 0.75 }, { path: 'other.js', weight: 0.5 }] });
  await withClock(1000, () => {
    assert.deepEqual(rightOfWay(agent('alpha'), moreWork), { hold: 'bravo', steer: 'alpha' });
    assert.deepEqual(rightOfWay(moreWork, agent('alpha')), { hold: 'bravo', steer: 'alpha' });
  });
});

test('standalone priority and unknown or future start-time fallbacks stay compatible', async () => {
  await withClock(0, () => {
    assert.deepEqual(agentPriority(agent('alpha')), { progress: 1, ageMs: NOW - Date.parse(START) });
    const unknown = agent('alpha', { startedAt: null });
    const invalid = agent('bravo', { startedAt: 'not a timestamp' });
    assert.deepEqual(rightOfWay(unknown, invalid), EXPECTED);
    assert.deepEqual(rightOfWay(invalid, unknown), EXPECTED);
    assert.deepEqual(rightOfWay(unknown, agent('bravo')), { hold: 'bravo', steer: 'alpha' });
    assert.deepEqual(rightOfWay(unknown, agent('bravo', { startedAt: '2027-01-01T00:00:00.000Z' })), EXPECTED);
  });
});

test('airspace scans emit the same hold and steer recipients in either input order', async () => {
  await withClock(1, () => {
    for (const agents of [[agent('alpha'), agent('bravo')], [agent('bravo'), agent('alpha')]]) {
      const scan = scanAirspace(agents);
      const [advisory] = scan.advisories;
      assert.equal(advisory.level, 'resolution');
      assert.equal(advisory.risk, 1);
      assert.deepEqual({ hold: advisory.hold, steer: advisory.steer }, EXPECTED);
      assert.deepEqual(buildProximityTriggers(scan.advisories).map(({ to, from, type }) => ({ to, from, type })), [
        { to: 'bravo', from: 'alpha', type: 'proximity_steer' },
        { to: 'alpha', from: 'bravo', type: 'proximity_hold' },
      ]);
    }
  });
});

const sessions = ['alpha', 'bravo'].map(id => ({ id, task: `Task ${id}`, state: 'running', createdAt: START }));
const snapshot = () => ({
  sessions,
  proximity: buildProximitySnapshot(sessions, { workingSetFor: () => agent('').files, graph: { adjacency: {} } }),
});

test('the public control-plane event agrees with the snapshot maneuver', async () => {
  await withClock(1, () => {
    const state = snapshot();
    const view = buildControlPlaneView(state, { now: new Date(NOW).toISOString() });
    const event = view.events.find(item => item.kind === EVENT_KINDS.advisory);
    assert.deepEqual(event.action, { type: 'steer', ...EXPECTED });
    assert.deepEqual({ hold: state.proximity.advisories[0].hold, steer: state.proximity.advisories[0].steer }, EXPECTED);
  });
});

test('unchanged ticks keep the same recipients so the dispatcher suppresses repeat messages', async () => {
  const sent = [];
  const dispatcher = createProximityDispatcher({ sendMessage: message => sent.push(message), now: () => NOW });
  const first = await withClock(0, () => runProximityTick({ buildSnapshot: snapshot, dispatcher }));
  const second = await withClock(1, () => runProximityTick({ buildSnapshot: snapshot, dispatcher }));
  assert.deepEqual(first.result, { dispatched: 2, suppressed: 0, skipped: 0 });
  assert.deepEqual(second.result, { dispatched: 0, suppressed: 2, skipped: 0 });
  assert.deepEqual(sent.map(({ toSession, msgType }) => ({ toSession, msgType })), [
    { toSession: 'bravo', msgType: 'proximity_steer' },
    { toSession: 'alpha', msgType: 'proximity_hold' },
  ]);
});

test('proximity-tick CLI retains deterministic arbitration for real SQLite sessions and Git worktrees', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-priority-'));
  try {
    const template = path.join(temp, 'template');
    fs.mkdirSync(template);
    const gitConfig = path.join(temp, 'empty.gitconfig');
    fs.writeFileSync(gitConfig, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: template });
    const repo = path.join(temp, 'repo');
    fs.mkdirSync(repo);
    const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { env, stdio: 'pipe' });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'priority-fixture');
    git(repo, 'config', 'user.email', 'priority-fixture@example.test');
    fs.writeFileSync(path.join(repo, 'shared.js'), 'export const value = 0;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'fixture base');
    const worktrees = ['alpha', 'bravo'].map((id, index) => {
      const directory = path.join(temp, id);
      git(repo, 'worktree', 'add', '-q', '-b', id, directory, 'main');
      fs.writeFileSync(path.join(directory, 'shared.js'), `export const value = ${index + 1};\n`);
      return { id, directory };
    });
    const SQL = await require('sql.js')();
    const db = new SQL.Database();
    const dbPath = path.join(temp, 'ecc2.db');
    try {
      db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, task TEXT, state TEXT, worktree_path TEXT,
        worktree_branch TEXT, worktree_base TEXT, created_at TEXT, updated_at TEXT)`);
      for (const { id, directory } of worktrees) {
        db.run('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, `Task ${id}`, 'running', directory, id, 'main', START, START]);
      }
      const clockFile = path.join(temp, 'clock.cjs');
      fs.writeFileSync(clockFile, `let now = ${NOW}; Date.now = () => ++now;\n`);
      for (const firstId of ['alpha', 'bravo']) {
        // The reader orders by updated_at; prove the result survives a new order.
        db.run('UPDATE sessions SET updated_at = CASE WHEN id = ? THEN ? ELSE ? END',
          [firstId, '2026-01-02T00:00:00.000Z', START]);
        fs.writeFileSync(dbPath, db.export());
        const result = spawnSync(process.execPath, [
          '--require', clockFile, path.resolve(__dirname, '../../scripts/proximity-tick.js'),
          '--dry-run', '--json', '--db', dbPath, '--state-db', path.join(temp, 'missing-state.db'),
        ], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const tick = JSON.parse(result.stdout);
        assert.equal(tick.counts.resolutions, 1);
        assert.equal(tick.advisories[0].a, firstId);
        assert.deepEqual({ hold: tick.advisories[0].hold, steer: tick.advisories[0].steer }, EXPECTED);
        assert.equal(tick.result.dryRun, true);
        assert.equal(tick.result.dispatched, 0);
      }
    } finally { db.close(); }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
