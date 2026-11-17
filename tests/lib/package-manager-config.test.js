'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cli = path.resolve(__dirname, '../../scripts/setup-package-manager.js');
const library = path.resolve(__dirname, '../../scripts/lib/package-manager.js');

function fixture(t, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pm-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config');
  const project = path.join(root, 'project');
  fs.mkdirSync(configDir);
  fs.mkdirSync(project);
  const config = path.join(configDir, 'package-manager.json');
  fs.writeFileSync(config, contents);
  const env = { ...process.env, HOME: root, USERPROFILE: root, ECC_AGENT_DATA_HOME: configDir };
  delete env.CLAUDE_PACKAGE_MANAGER;
  return { config, project, env };
}

function setGlobal(context, name) {
  return spawnSync(process.execPath, [cli, '--global', name], {
    cwd: context.project, env: context.env, encoding: 'utf8', timeout: 10000,
  });
}

function selected(context) {
  // A new process must observe the saved preference, not an in-memory property.
  const result = spawnSync(process.execPath, ['-e',
    'console.log(JSON.stringify(require(process.argv[1]).getPackageManager()))', library,
  ], { cwd: context.project, env: context.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const value of [[], ['npm'], 'pnpm', true, 17]) {
  test(`setting a global preference replaces non-object config ${JSON.stringify(value)}`, t => {
    const context = fixture(t, JSON.stringify(value));
    const result = setGlobal(context, 'bun');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Global preference set to: bun/);
    const saved = JSON.parse(fs.readFileSync(context.config, 'utf8'));
    assert.equal(saved.packageManager, 'bun');
    assert.equal(typeof saved.setAt, 'string');
    assert.equal(Number.isNaN(Date.parse(saved.setAt)), false);
    assert.equal(selected(context).name, 'bun');
    assert.equal(selected(context).source, 'global-config');
  });
}

test('invalid JSON and falsy JSON values retain the existing recovery behavior', t => {
  for (const contents of ['{ invalid', 'null', 'false', '0', '""']) {
    const context = fixture(t, contents);
    const result = setGlobal(context, 'pnpm');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(selected(context).name, 'pnpm');
    assert.equal(JSON.parse(fs.readFileSync(context.config, 'utf8')).packageManager, 'pnpm');
  }
});

test('a valid object retains unrelated configuration when the preference changes', t => {
  const original = { packageManager: 'npm', setAt: '2020-01-01', custom: { labels: ['one', 'two'] } };
  const context = fixture(t, JSON.stringify(original));
  assert.equal(selected(context).name, 'npm');
  const result = setGlobal(context, 'yarn');
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(context.config, 'utf8'));
  assert.deepEqual(saved.custom, original.custom);
  assert.equal(saved.packageManager, 'yarn');
  assert.notEqual(saved.setAt, original.setAt);
  assert.equal(selected(context).name, 'yarn');
});

test('an unsupported manager cannot rewrite any existing configuration shape', t => {
  for (const contents of ['["preserve"]', '{ "custom": true }\n']) {
    const context = fixture(t, contents);
    const result = setGlobal(context, 'constructor');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown package manager/);
    assert.equal(fs.readFileSync(context.config, 'utf8'), contents);
  }
});
