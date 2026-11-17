'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const adapter = path.resolve(__dirname, '../../scripts/lib/control-pane/proximity.js');
const routingKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

function cleanGitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-proximity-env-'));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
    env: cleanGitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const initialize = name => {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'proximity-test');
    git(repo, 'config', 'user.email', 'proximity-test@example.invalid');
    for (const file of ['committed.js', 'staged.js', 'unstaged.js']) {
      fs.writeFileSync(path.join(repo, file), 'const value = 1;\n');
    }
    fs.writeFileSync(path.join(repo, 'identity.txt'), `${name}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'base');
    return repo;
  };
  try {
    const target = initialize('requested repo');
    const foreign = initialize('hook host');
    const linked = path.join(root, 'linked worktree');
    git(target, 'worktree', 'add', '-qb', 'task', linked, 'main');
    const base = git(target, 'rev-parse', 'HEAD').trim();
    for (const repo of [target, linked]) {
      fs.writeFileSync(path.join(repo, 'committed.js'), 'const value = 2;\n');
      git(repo, 'add', 'committed.js');
      git(repo, 'commit', '-qm', 'committed task edit');
      fs.writeFileSync(path.join(repo, 'staged.js'), 'const value = 3;\n');
      git(repo, 'add', 'staged.js');
      fs.writeFileSync(path.join(repo, 'unstaged.js'), 'const value = 4;\n');
      fs.writeFileSync(path.join(repo, 'untracked.js'), 'const value = 5;\n');
    }
    fs.writeFileSync(path.join(foreign, 'foreign-only.js'), 'foreign work\n');
    git(foreign, 'add', 'foreign-only.js');
    const selectors = {
      GIT_DIR: path.join(foreign, '.git'),
      GIT_WORK_TREE: foreign,
      GIT_INDEX_FILE: path.join(foreign, '.git', 'index'),
      GIT_COMMON_DIR: path.join(foreign, '.git'),
      GIT_PREFIX: 'unrelated/',
    };
    const sessions = [target, linked].map((repo, index) => ({
      id: `worker-${index}`, worktree: { path: repo, base },
    }));
    const statusBefore = [target, linked, foreign].map(repo => git(repo, 'status', '--porcelain=v1'));
    const run = (overrides, requestedSessions = sessions) => {
      const script = `
        const assert = require('node:assert/strict');
        const api = require(process.argv[1]);
        const sessions = JSON.parse(process.argv[2]);
        const keys = JSON.parse(process.argv[3]);
        const before = keys.map(key => process.env[key]);
        const results = sessions.map(session => ({
          working: api.defaultWorkingSetFor(session),
          changed: api.defaultChangedFilesFor(session),
        }));
        const snapshot = api.buildProximitySnapshot(sessions, {graph: {adjacency: {}}});
        assert.deepEqual(keys.map(key => process.env[key]), before);
        process.stdout.write(JSON.stringify({results, snapshot}));
      `;
      return JSON.parse(execFileSync(process.execPath, [
        '-e', script, adapter, JSON.stringify(requestedSessions), JSON.stringify(routingKeys),
      ], {
        env: { ...cleanGitEnv(), ...overrides }, encoding: 'utf8', timeout: 15000,
      }));
    };
    fn({ run, selectors, root, target });
    assert.deepEqual([target, linked, foreign].map(repo => git(repo, 'status', '--porcelain=v1')), statusBefore);
    assert.equal(fs.readFileSync(path.join(foreign, 'foreign-only.js'), 'utf8'), 'foreign work\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertRequestedWork({ results, snapshot }) {
  const names = ['committed.js', 'staged.js', 'unstaged.js', 'untracked.js'];
  for (const result of results) {
    assert.deepEqual(result.working.map(file => file.path).sort(), names);
    assert.deepEqual(result.changed.sort(), names);
    for (const file of result.working) {
      assert.deepEqual(file.lines, file.path === 'untracked.js' ? undefined : [[1, 1]]);
    }
  }
  assert.equal(snapshot.counts.agents, 2);
  assert.ok(snapshot.advisories.some(advisory => advisory.level === 'resolution'));
  assert.ok(snapshot.agents.every(agent => !agent.files.includes('foreign-only.js')));
}

for (const selector of [...routingKeys, 'all', 'none']) {
  test(`explicit repository and linked worktree win over inherited ${selector}`, () => {
    fixture(({ run, selectors }) => {
      const overrides = selector === 'all' ? selectors
        : selector === 'none' ? {} : { [selector]: selectors[selector] };
      assertRequestedWork(run(overrides));
    });
  });
}

test('unavailable session repositories cannot borrow the inherited host repository', () => {
  fixture(({ run, selectors, root, target }) => {
    const sessions = [
      null,
      { id: 'no-worktree' },
      { id: 'no-path', worktree: {} },
      { id: 'missing', worktree: { path: path.join(root, 'missing') } },
      { id: 'outside', worktree: { path: root } },
      { id: 'bad-base', worktree: { path: target, base: 'missing-base' } },
    ];
    const { results, snapshot } = run(selectors, sessions);
    assert.deepEqual(results, sessions.map(() => ({ working: [], changed: [] })));
    assert.equal(snapshot.counts.agents, 0);
    assert.deepEqual(snapshot.advisories, []);
  });
});

test('the default HEAD base still selects only uncommitted work from the requested repository', () => {
  fixture(({ run, selectors, target }) => {
    const { results, snapshot } = run(selectors, [{ id: 'head-default', worktree: { path: target } }]);
    const names = ['staged.js', 'unstaged.js', 'untracked.js'];
    assert.deepEqual(results[0].working.map(file => file.path).sort(), names);
    assert.deepEqual(results[0].changed.sort(), names);
    assert.equal(snapshot.counts.agents, 1);
    assert.deepEqual(snapshot.advisories, []);
  });
});
