'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const pm = require('../../scripts/lib/package-manager');

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pm-bom-'));
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  fs.mkdirSync(project);
  fs.mkdirSync(config);
  const before = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_PACKAGE_MANAGER: process.env.CLAUDE_PACKAGE_MANAGER };
  process.env.CLAUDE_CONFIG_DIR = config;
  delete process.env.CLAUDE_PACKAGE_MANAGER;
  try { callback({ project, config }); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a BOM-prefixed package.json keeps its explicit package manager', () => fixture(({ project }) => {
  fs.writeFileSync(path.join(project, 'package.json'), '\uFEFF{"packageManager":"pnpm@10.0.0"}');
  assert.equal(pm.detectFromPackageJson(project), 'pnpm');
  const selected = pm.getPackageManager({ projectDir: project });
  assert.equal(selected.name, 'pnpm');
  assert.equal(selected.source, 'package.json');
}));

test('BOM-prefixed project settings retain priority over a lockfile', () => fixture(({ project }) => {
  fs.mkdirSync(path.join(project, '.claude'));
  fs.writeFileSync(path.join(project, '.claude/package-manager.json'), '\uFEFF{"packageManager":"yarn"}');
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');
  const selected = pm.getPackageManager({ projectDir: project });
  assert.equal(selected.name, 'yarn');
  assert.equal(selected.source, 'project-config');
}));

test('BOM-prefixed global settings remain selectable', () => fixture(({ project, config }) => {
  fs.writeFileSync(path.join(config, 'package-manager.json'), '\uFEFF{"packageManager":"bun"}');
  const selected = pm.getPackageManager({ projectDir: project });
  assert.equal(selected.name, 'bun');
  assert.equal(selected.source, 'global-config');
}));

test('updating a BOM-prefixed global preference preserves unrelated settings', () => fixture(({ config }) => {
  const file = path.join(config, 'package-manager.json');
  fs.writeFileSync(file, '\uFEFF{"packageManager":"bun","custom":{"keep":true}}');
  pm.setPreferredPackageManager('pnpm');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.packageManager, 'pnpm');
  assert.deepEqual(saved.custom, { keep: true });
}));

test('the setup detector reports the BOM-prefixed package preference', () => fixture(({ project }) => {
  fs.writeFileSync(path.join(project, 'package.json'), '\uFEFF{"packageManager":"pnpm@10.0.0"}');
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/setup-package-manager.js'), '--detect'], {
    cwd: project, env: { ...process.env }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Package Manager: pnpm/);
  assert.match(child.stdout, /Source: package\.json/);
}));

test('ordinary JSON and invalid metadata retain their existing behavior', () => fixture(({ project }) => {
  const file = path.join(project, 'package.json');
  for (const content of ['{"packageManager":"yarn"}']) {
    fs.writeFileSync(file, content);
    assert.equal(pm.detectFromPackageJson(project), 'yarn');
  }
  for (const content of ['{"packageManager":"pnpm\uFEFF"}', '{malformed}', '\uFEFF\uFEFF{"packageManager":"pnpm"}']) {
    fs.writeFileSync(file, content);
    assert.equal(pm.detectFromPackageJson(project), null);
  }
}));
