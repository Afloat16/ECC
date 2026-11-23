'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createGitRunner } = require('../../scripts/lib/worktree-lifecycle/git');
const { buildLifecycleReport } = require('../../scripts/lib/worktree-lifecycle/lifecycle');

const codeRoot = path.resolve(__dirname, '../..');
const NOW = Date.UTC(2030, 0, 1);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-worktree-times-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[name];
  fs.mkdirSync(repo);
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const runGit = (args, options = {}) => {
    const result = spawnSync('git', args, { cwd: options.cwd || repo, env: { ...env, ...options.env },
      encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (cwd, seconds) => runGit(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], { cwd,
    env: { GIT_AUTHOR_DATE: '@' + seconds + ' +0000', GIT_COMMITTER_DATE: '@' + seconds + ' +0000' } });
  runGit(['init', '-qb', 'main']);
  fs.writeFileSync(path.join(repo, 'app.txt'), 'main\n');
  runGit(['add', '.']);
  commit(repo, 1600000000);
  let next = 0;
  const addWorker = (branch, seconds = null) => {
    const cwd = path.join(root, 'worker-' + next++);
    runGit(['worktree', 'add', '-qb', branch, cwd, 'main']);
    if (seconds !== null) {
      fs.writeFileSync(path.join(cwd, 'worker.txt'), branch + '\n');
      runGit(['add', 'worker.txt'], { cwd });
      commit(cwd, seconds);
    }
    return cwd;
  };
  const runner = () => createGitRunner(repo, (args, options) => spawnSync('git', args,
    { cwd: options.cwd, env, encoding: 'utf8', timeout: 10000 }));
  return { root, repo, env, runGit, commit, addWorker, runner };
}

function inspect(f, legacy = false) {
  const git = f.runner();
  return buildLifecycleReport(f.repo, { nowMs: NOW }, { git: legacy ? { ...git, lastCommitTimes: undefined } : git });
}

test('real mixed branch dates preserve the complete report and cleanup classifications', t => {
  const f = fixture(t);
  f.addWorker('merged');
  f.addWorker('feature/first', 1610000000);
  f.addWorker('feature/second', 1620000000);
  const dirty = f.addWorker('dirty', 1630000000);
  fs.appendFileSync(path.join(dirty, 'app.txt'), 'uncommitted\n');
  f.addWorker('unicode-' + '\u4e2d\u6587', 1640000000);
  const report = inspect(f);
  assert.deepEqual(report, inspect(f, true));
  const rows = Object.fromEntries(report.worktrees.map(entry => [entry.branch, entry]));
  assert.equal(rows.main.lastCommitMs, 1600000000000);
  assert.equal(rows['feature/first'].lastCommitMs, 1610000000000);
  assert.equal(rows['feature/second'].lastCommitMs, 1620000000000);
  assert.equal(rows.dirty.state, 'dirty');
  assert.equal(rows.merged.state, 'merged');
});

test('a new report observes branch commits made after the previous collection', t => {
  const f = fixture(t);
  const worker = f.addWorker('feature', 1610000000);
  assert.equal(inspect(f).worktrees.find(entry => entry.branch === 'feature').lastCommitMs, 1610000000000);
  fs.appendFileSync(path.join(worker, 'worker.txt'), 'new commit\n');
  f.runGit(['add', 'worker.txt'], { cwd: worker });
  f.commit(worker, 1650000000);
  assert.equal(inspect(f).worktrees.find(entry => entry.branch === 'feature').lastCommitMs, 1650000000000);
});

for (const failBatch of [false, true]) {
  test('a same-name tag cannot replace the branch date' + (failBatch ? ' after batch failure' : ''), t => {
    const f = fixture(t);
    f.addWorker('release', 1610000000);
    f.addWorker('tag-target', 1700000000);
    f.runGit(['tag', 'release', 'refs/heads/tag-target']);
    const git = createGitRunner(f.repo, (args, options) => {
      if (failBatch && args[0] === 'for-each-ref') return { status: 128, stdout: '', stderr: 'fixture batch failure' };
      return spawnSync('git', args, { cwd: options.cwd, env: f.env, encoding: 'utf8', timeout: 10000 });
    });
    const report = buildLifecycleReport(f.repo, { nowMs: NOW }, { git });
    assert.equal(report.worktrees.find(entry => entry.branch === 'release').lastCommitMs, 1610000000000);
  });
}

test('the public CLI does not start one timestamp process per worktree', t => {
  const f = fixture(t);
  for (let i = 0; i < 24; i++) f.addWorker('worker-' + i);
  const callFile = path.join(f.root, 'git-calls.jsonl');
  const preload = path.join(f.root, 'record-git.cjs');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    'const original = cp.spawnSync;',
    'cp.spawnSync = (program, args, options) => {',
    "  if (program === 'git') fs.appendFileSync(process.env.ECC_GIT_CALLS, JSON.stringify(args) + '\\n');",
    '  return original(program, args, options);',
    '};'
  ].join('\n'));
  const result = spawnSync(process.execPath, [path.join(codeRoot, 'scripts/worktree-lifecycle.js'),
    '--repo', f.repo, '--json'], { cwd: f.repo, env: { ...f.env, NODE_OPTIONS: '--require=' + preload,
    ECC_GIT_CALLS: callFile }, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.worktrees.length, 25);
  assert.ok(report.worktrees.every(entry => entry.lastCommitMs === 1600000000000));
  const calls = fs.readFileSync(callFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.length <= 51, '25 worktrees must not require 75 Git processes: ' + calls.length);
  assert.ok(calls.filter(args => args[0] === 'log' || args[0] === 'for-each-ref').length <= 1);
});

function synthetic(count, options = {}) {
  const branches = Array.from({ length: count }, (_, index) =>
    (options.longNames ? 'segment0123456789/'.repeat(30) : 'branch-') + index);
  const seconds = new Map(branches.map((branch, index) => [branch, index === 0 ? 0 : 1600000000 + index]));
  const calls = [];
  const git = createGitRunner('/repo', args => {
    calls.push(args);
    if (args[0] === 'worktree') return { status: 0, stdout: branches.map((branch, index) =>
      ['worktree /worker-' + index, 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/' + branch, ''].join('\0')).join('\0') };
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'rev-list') return { status: 0, stdout: '0\t0\n', stderr: '' };
    if (args[0] === 'log') {
      const branch = args[3].replace(/^refs\/heads\//, '');
      return { status: 0, stdout: String(seconds.get(branch)) + '\n', stderr: '' };
    }
    if (args[0] === 'for-each-ref') {
      if (options.batchFailure) return { status: 128, stdout: 'refs/heads/' + branches[0] + '\0' + '1\n', stderr: 'fixture failed' };
      const refs = args.filter(arg => arg.startsWith('refs/heads/'));
      return { status: 0, stdout: refs.filter(ref => ref !== options.missingRef).map(ref =>
        ref + '\0' + seconds.get(ref.slice('refs/heads/'.length)) + '\n').join('')
        + 'refs/heads/unselected-child\0' + '42\n', stderr: '' };
    }
    throw new Error('Unexpected Git command: ' + args.join(' '));
  });
  return { branches, seconds, calls, git };
}

test('large branch sets keep timestamp subprocess arguments bounded', () => {
  const f = synthetic(160, { longNames: true });
  const report = buildLifecycleReport('/repo', { nowMs: NOW }, { git: f.git });
  assert.equal(report.worktrees.length, f.branches.length);
  report.worktrees.forEach((entry, index) => assert.equal(entry.lastCommitMs,
    index === 0 ? null : f.seconds.get(f.branches[index]) * 1000));
  const queries = f.calls.filter(args => args[0] === 'log' || args[0] === 'for-each-ref');
  assert.ok(queries.length <= 20, 'Long ref names must still batch date lookups: ' + queries.length);
  assert.ok(queries.every(args => args.join(' ').length < 16384), 'Keep each subprocess argument list bounded');
});

test('failed batch observations retain the existing individual-read fallback', () => {
  const f = synthetic(3, { batchFailure: true });
  const report = buildLifecycleReport('/repo', { nowMs: NOW }, { git: f.git });
  assert.deepEqual(report.worktrees.map(entry => entry.lastCommitMs), [null, 1600000001000, 1600000002000]);
  assert.equal(f.calls.filter(args => args[0] === 'log').length, 3);
});

test('a missing batch ref falls back individually without rereading known dates', () => {
  const f = synthetic(3, { missingRef: 'refs/heads/branch-1' });
  const report = buildLifecycleReport('/repo', { nowMs: NOW }, { git: f.git });
  assert.deepEqual(report.worktrees.map(entry => entry.lastCommitMs), [null, 1600000001000, 1600000002000]);
  assert.equal(f.calls.filter(args => args[0] === 'log').length, 1);
});

test('custom Git adapters without a batch method retain their existing behavior', () => {
  const f = synthetic(3);
  const git = { ...f.git, lastCommitTimes: undefined };
  const report = buildLifecycleReport('/repo', { nowMs: NOW }, { git });
  assert.deepEqual(report.worktrees.map(entry => entry.lastCommitMs), [null, 1600000001000, 1600000002000]);
  assert.equal(f.calls.filter(args => args[0] === 'log').length, 3);
});

test('an empty worktree inventory does not request commit dates', () => {
  const f = synthetic(0);
  const report = buildLifecycleReport('/repo', { nowMs: NOW }, { git: f.git });
  assert.deepEqual(report.worktrees, []);
  assert.equal(f.calls.filter(args => args[0] === 'log' || args[0] === 'for-each-ref').length, 0);
});
