'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { getRepoCommit } = require('../../scripts/lib/install/plan');

const BINDINGS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'];

function cleanGitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !BINDINGS.includes(key)));
}

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, env: cleanGitEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(directory, marker) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, 'init', '-q');
  fs.writeFileSync(path.join(directory, 'marker'), marker);
  git(directory, 'add', 'marker');
  git(directory, '-c', 'user.name=ECC Test', '-c', 'user.email=ecc-test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', marker);
  return git(directory, 'rev-parse', 'HEAD');
}

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-source-commit-'));
  const before = Object.fromEntries(BINDINGS.map(key => [key, process.env[key]]));
  try { callback(root); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a source checkout reports its own commit', () => fixture(root => {
  const expected = initRepo(root, 'source');
  assert.equal(getRepoCommit(root), expected);
}));

test('source revision ignores repository bindings inherited from the caller', () => fixture(root => {
  const source = path.join(root, 'source');
  const caller = path.join(root, 'caller');
  const expected = initRepo(source, 'source');
  const unrelated = initRepo(caller, 'caller');
  assert.notEqual(expected, unrelated);
  process.env.GIT_DIR = path.join(caller, '.git');
  process.env.GIT_WORK_TREE = caller;
  process.env.GIT_COMMON_DIR = path.join(caller, '.git');
  process.env.GIT_INDEX_FILE = path.join(caller, '.git', 'index');
  process.env.GIT_PREFIX = 'unrelated/';
  assert.equal(getRepoCommit(source), expected);
}));

test('an invalid inherited Git directory does not hide a valid checkout', () => fixture(root => {
  const expected = initRepo(root, 'source');
  process.env.GIT_DIR = path.join(root, 'missing');
  assert.equal(getRepoCommit(root), expected);
}));

test('a distributed package does not claim the enclosing consumer repository commit', () => fixture(root => {
  initRepo(root, 'consumer');
  const installedPackage = path.join(root, 'node_modules', 'ecc-universal');
  fs.mkdirSync(installedPackage, { recursive: true });
  fs.writeFileSync(path.join(installedPackage, 'package.json'), '{"version":"2.2.3"}');
  assert.equal(getRepoCommit(installedPackage), null);
}));

test('a linked Git worktree remains a valid source checkout', () => fixture(root => {
  const source = path.join(root, 'source');
  const linked = path.join(root, 'linked');
  const expected = initRepo(source, 'source');
  git(source, 'worktree', 'add', '--detach', linked, 'HEAD');
  assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
  assert.equal(getRepoCommit(linked), expected);
}));

test('the public dry-run records ECC provenance even when invoked from a Git hook', () => fixture(root => {
  const caller = path.join(root, 'caller');
  const home = path.join(root, 'home');
  const expected = git(path.resolve(__dirname, '../..'), 'rev-parse', 'HEAD');
  initRepo(caller, 'caller');
  fs.mkdirSync(home);
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/install-apply.js'),
    '--target', 'mistral-vibe', '--skills', 'tdd-workflow', '--dry-run', '--json'], {
    cwd: caller, encoding: 'utf8', timeout: 30000,
    env: { ...cleanGitEnvironment(), HOME: home, USERPROFILE: home, GIT_DIR: path.join(caller, '.git') },
  });
  assert.equal(child.status, 0, child.stderr);
  const { dryRun, plan } = JSON.parse(child.stdout);
  assert.equal(dryRun, true);
  assert.equal(plan.statePreview.source.repoCommit, expected);
  assert.ok(!fs.existsSync(path.join(caller, '.vibe')));
}));
