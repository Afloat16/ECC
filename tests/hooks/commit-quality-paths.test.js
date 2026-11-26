'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../scripts/hooks/pre-bash-commit-quality.js');
const input = JSON.stringify({ tool_input: { command: 'git commit -m "fix: check staged paths"' } });
let passed = 0;
let failed = 0;
let skipped = 0;

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-commit-paths-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    git(['init', '-q']);
    git(['config', 'core.quotePath', 'true']);
    const stage = (name, content) => {
      fs.writeFileSync(path.join(root, name), content);
      git(['add', '--', name]);
    };
    const run = () => {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd: root, env, input, encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.stdout, input);
      return result;
    };
    callback({ root, git, stage, run });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function test(name, fn, skip = false) {
  if (skip) { skipped++; console.log(`  SKIP ${name}`); return; }
  try { fixture(fn); passed++; console.log(`  PASS ${name}`); }
  catch (error) { failed++; console.log(`  FAIL ${name}: ${error.message}`); }
}

for (const name of ['功能.js', ' leading.js', 'trailing .js', 'tab\tname.js', 'line\nname.js', 'quote"name.js', 'back\\slash.js']) {
  test(`checks the staged snapshot for ${JSON.stringify(name)}`, ({ root, stage, run }) => {
    stage(name, 'debugger;\n');
    // The hook must inspect the index, even when the working file is clean.
    fs.writeFileSync(path.join(root, name), 'const clean = true;\n');
    const result = run();
    assert.strictEqual(result.status, 2, result.stderr);
    assert.match(result.stderr, /debugger statement at line 1/);
  }, process.platform === 'win32' && /[\t\n"\\]/.test(name));
}

test('ordinary filenames retain blocking behavior', ({ stage, run }) => {
  stage('ordinary.js', 'debugger;\n');
  assert.strictEqual(run().status, 2);
});

test('clean Unicode snapshots pass even when working files contain a debugger', ({ root, stage, run }) => {
  stage('安全.js', 'const clean = true;\n');
  fs.writeFileSync(path.join(root, '安全.js'), 'debugger;\n');
  const result = run();
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /All checks passed/);
});

test('multiple names remain distinct instead of becoming quoted or split paths', ({ stage, run }) => {
  stage('first.js', 'const clean = true;\n');
  stage('第二.js', 'debugger;\n');
  const result = run();
  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /Checking 2 staged file/);
});

test('an empty index remains a nonblocking no-op', ({ run }) => {
  const result = run();
  assert.strictEqual(result.status, 0);
  assert.match(result.stderr, /No staged files/);
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`);
process.exitCode = failed ? 1 : 0;
