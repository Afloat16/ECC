'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const pm = require('../../scripts/lib/package-manager');

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pm-dev-engines-'));
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  fs.mkdirSync(project);
  fs.mkdirSync(config);
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_PACKAGE_MANAGER: process.env.CLAUDE_PACKAGE_MANAGER };
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.CLAUDE_PACKAGE_MANAGER;
  const writePackage = value => fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify(value));
  try { callback({ project, writePackage }); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('devEngines package-manager metadata detects each supported manager', () => fixture(({ project, writePackage }) => {
  for (const name of ['npm', 'pnpm', 'yarn', 'bun']) {
    writePackage({ devEngines: { packageManager: { name, version: '>=1', onFail: 'error' } } });
    assert.equal(pm.detectFromPackageJson(project), name);
  }
}));

test('devEngines metadata takes package.json priority over a conflicting lockfile', () => fixture(({ project, writePackage }) => {
  writePackage({ devEngines: { packageManager: { name: 'yarn' } } });
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
  const selected = pm.getPackageManager({ projectDir: project });
  assert.equal(selected.name, 'yarn');
  assert.equal(selected.source, 'package.json');
}));

test('top-level packageManager and explicit ECC overrides retain priority', () => fixture(({ project, writePackage }) => {
  writePackage({ packageManager: 'npm@11.0.0', devEngines: { packageManager: { name: 'pnpm' } } });
  assert.equal(pm.detectFromPackageJson(project), 'npm');
  pm.setProjectPackageManager('yarn', project);
  assert.equal(pm.getPackageManager({ projectDir: project }).name, 'yarn');
  process.env.CLAUDE_PACKAGE_MANAGER = 'bun';
  assert.equal(pm.getPackageManager({ projectDir: project }).name, 'bun');
}));

test('invalid, ambiguous and unsupported engine declarations remain ignored', () => fixture(({ project, writePackage }) => {
  for (const engine of [null, false, 7, 'pnpm', [], [{ name: 'pnpm' }], {},
    { name: 7 }, { name: 'pnpm@10.0.0' }, { name: 'constructor' }, { name: '__proto__' }, { name: 'unknown' }]) {
    writePackage({ devEngines: { packageManager: engine } });
    assert.equal(pm.detectFromPackageJson(project), null);
  }
  for (const value of [null, [], 'pnpm']) {
    writePackage({ devEngines: value });
    assert.equal(pm.detectFromPackageJson(project), null);
  }
  writePackage({ packageManager: 'unknown@1', devEngines: { packageManager: { name: 'pnpm' } } });
  assert.equal(pm.detectFromPackageJson(project), null);
  writePackage({ engines: { pnpm: '>=9' } });
  assert.equal(pm.detectFromPackageJson(project), null);
}));

test('command generation uses the declared development package manager', () => fixture(({ project, writePackage }) => {
  writePackage({ devEngines: { packageManager: { name: 'pnpm' } } });
  assert.equal(pm.getRunCommand('test', { projectDir: project }), 'pnpm test');
  assert.equal(pm.getExecCommand('eslint', '--version', { projectDir: project }), 'pnpm dlx eslint --version');
}));

test('the setup CLI reports devEngines as the package.json preference', () => fixture(({ project, writePackage }) => {
  writePackage({ devEngines: { packageManager: { name: 'pnpm' } } });
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/setup-package-manager.js'), '--detect'], {
    cwd: project, env: { ...process.env }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Package Manager: pnpm/);
  assert.match(child.stdout, /Source: package\.json/);
  assert.match(child.stdout, /Install: pnpm install/);
}));
