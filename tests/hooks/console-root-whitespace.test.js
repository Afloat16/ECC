'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const hook = path.resolve(__dirname, '../../scripts/hooks/check-console-log.js');
const payload = '{"session_id":"root-path-check","text":"keep exact input"}\n';

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
}

function fixture(t, suffix, initialize = true) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-console-root-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, `project${suffix}`);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const env = { ...cleanEnvironment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(parent, 'empty-gitconfig') };
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const file = path.join(root, 'src', 'app.js');
  fs.writeFileSync(file, 'export const value = 1;\n');
  if (initialize) {
    git('init', '-q');
    git('add', '--', 'src/app.js');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
  }
  fs.writeFileSync(file, 'console.log("debug");\n');
  return { root, file, env, git };
}

function run(context, cwd = context.root, extraEnv = {}, input = payload) {
  const result = spawnSync(process.execPath, [hook], {
    cwd, env: { ...context.env, ...extraEnv }, input, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
  return result.stderr;
}

for (const suffix of [' ', '\t', '\n', '\r', '\u00a0', '\u3000']) {
  test(`console checks preserve root suffix ${JSON.stringify(suffix)}`, { skip: process.platform === 'win32' }, t => {
    const context = fixture(t, suffix);
    const before = fs.readFileSync(context.file);
    for (const cwd of [context.root, path.join(context.root, 'src')]) {
      assert.match(run(context, cwd), /WARNING: console\.log found in src\/app\.js/);
    }
    assert.deepEqual(fs.readFileSync(context.file), before);
  });
}

test('root preservation keeps inherited foreign Git selectors isolated', { skip: process.platform === 'win32' }, t => {
  const context = fixture(t, ' ');
  const foreign = fixture(t, '-foreign');
  fs.writeFileSync(foreign.file, 'export const value = 2;\n');
  context.git('config', 'diff.relative', 'true');
  const stderr = run(context, path.join(context.root, 'src'), {
    GIT_DIR: path.join(foreign.root, '.git'), GIT_WORK_TREE: foreign.root,
    GIT_INDEX_FILE: path.join(foreign.root, '.git/index'),
  });
  assert.match(stderr, /WARNING: console\.log found in src\/app\.js/);
});

test('ordinary root names with internal spaces and Unicode retain warnings', t => {
  const context = fixture(t, ' with spaces \u4e2d\u6587');
  assert.match(run(context), /WARNING: console\.log found in src\/app\.js/);
});

test('modified files without debug output remain quiet', t => {
  const context = fixture(t, '-quiet');
  fs.writeFileSync(context.file, 'export const value = 2;\n');
  assert.equal(run(context), '');
});

test('a directory outside Git preserves the input without warnings', t => {
  const context = fixture(t, '-plain', false);
  assert.equal(run(context), '');
});

test('a clean worktree has no modified files to inspect', t => {
  const context = fixture(t, '-clean');
  fs.writeFileSync(context.file, 'export const value = 1;\n');
  assert.equal(context.git('status', '--porcelain'), '');
  assert.equal(run(context), '');
});

test('deleted source files and excluded test files remain skipped', t => {
  const context = fixture(t, '-excluded');
  const ignored = path.join(context.root, 'src', 'app.test.js');
  fs.writeFileSync(ignored, 'export {};\n');
  context.git('add', '--', 'src/app.test.js');
  context.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', 'commit', '-qm', 'test fixture');
  fs.writeFileSync(ignored, 'console.log("test output");\n');
  fs.unlinkSync(context.file);
  assert.equal(run(context), '');
});

test('an empty direct invocation exits successfully without writing a payload', t => {
  const context = fixture(t, '-empty', false);
  assert.equal(run(context, context.root, {}, ''), '');
});

test('Git root lookup failure in a bare repository still preserves the payload', t => {
  const context = fixture(t, '-bare', false);
  context.git('init', '--bare', '-q');
  assert.doesNotMatch(run(context), /WARNING: console\.log/);
});
