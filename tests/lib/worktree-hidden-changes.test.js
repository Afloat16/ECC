'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildLifecycleReport, planCleanup } = require('../../scripts/lib/worktree-lifecycle/lifecycle');

function fixture(t, submodule = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hidden-worktree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const worktree = path.join(dir, 'worker');
  const config = path.join(dir, 'empty-config');
  fs.writeFileSync(config, '');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  function git(cwd, ...args) {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  function init(target) {
    fs.mkdirSync(target);
    git(target, 'init', '-b', 'main');
    git(target, 'config', 'user.name', 'Fixture');
    git(target, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(target, 'tracked.txt'), 'original\n');
    fs.writeFileSync(path.join(target, '.gitignore'), 'cache/\n');
    git(target, 'add', '.');
    git(target, 'commit', '-m', 'initial');
  }
  init(repo);
  if (submodule) {
    const dependency = path.join(dir, 'dependency');
    init(dependency);
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'dependency');
    git(repo, 'config', '-f', '.gitmodules', 'submodule.dependency.ignore', 'all');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'add dependency');
  }
  git(repo, 'worktree', 'add', '-b', 'worker', worktree);
  if (submodule) git(worktree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init');
  function report() {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/worktree-lifecycle.js'),
      '--repo', repo, '--json'], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  return { repo, worktree, git, report };
}

test('hidden untracked work is dirty and excluded from CLI cleanup recommendations', t => {
  const { repo, worktree, git, report } = fixture(t);
  git(repo, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(worktree, 'unfinished.txt'), 'unsaved work\n');
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  const result = report();
  assert.equal(result.worktrees.find(row => row.branch === 'worker').state, 'dirty');
  assert.equal(planCleanup(result).remove.length, 0);
  assert.equal(planCleanup(result).keep[0].branch, 'worker');
  assert.equal(git(repo, 'config', 'status.showUntrackedFiles').trim(), 'no');
  assert.equal(fs.readFileSync(path.join(worktree, 'unfinished.txt'), 'utf8'), 'unsaved work\n');
});

test('ignored submodule work is visible to the lifecycle safety check', t => {
  const { worktree, git, report } = fixture(t, true);
  fs.writeFileSync(path.join(worktree, 'dependency/tracked.txt'), 'submodule work\n');
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  const result = report();
  assert.equal(result.worktrees.find(row => row.branch === 'worker').state, 'dirty');
  assert.equal(planCleanup(result).remove.length, 0);
});

test('ignored files alone keep a merged worktree eligible for cleanup', t => {
  const { repo, worktree, git, report } = fixture(t);
  git(repo, 'config', 'status.showUntrackedFiles', 'no');
  fs.mkdirSync(path.join(worktree, 'cache'));
  fs.writeFileSync(path.join(worktree, 'cache/temporary.txt'), 'ignored\n');
  const result = report();
  assert.equal(result.worktrees.find(row => row.branch === 'worker').state, 'merged');
  assert.equal(planCleanup(result).remove[0].branch, 'worker');
});

test('tracked modifications retain their existing dirty classification', t => {
  const { repo, worktree, git } = fixture(t);
  git(repo, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'changed\n');
  const report = buildLifecycleReport(repo);
  assert.equal(report.worktrees.find(row => row.branch === 'worker').state, 'dirty');
  assert.equal(planCleanup(report).remove.length, 0);
});
