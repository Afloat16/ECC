'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { deepMergeJson } = require('../../scripts/lib/install/json-ops');
const { createInstallPlanFromRequest } = require('../../scripts/lib/install/runtime');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');
const {
  buildDoctorReport, repairInstalledStates, uninstallInstalledStates,
} = require('../../scripts/lib/install-lifecycle');

const PAYLOAD = JSON.parse('{"mcpServers":{"managed":{"command":"managed-server"}},"metadata":{"__proto__":{"enabled":true},"constructor":{"label":"managed"}}}');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-install-json-keys-'));
  const sourceRoot = path.join(root, 'source');
  const projectRoot = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const configPath = path.join(projectRoot, '.cursor/mcp.json');
  const statePath = path.join(projectRoot, '.cursor/ecc-install-state.json');
  const previous = process.env.ECC_DISABLED_MCPS;
  delete process.env.ECC_DISABLED_MCPS;
  t.after(() => {
    if (previous === undefined) delete process.env.ECC_DISABLED_MCPS;
    else process.env.ECC_DISABLED_MCPS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeJson(path.join(sourceRoot, 'package.json'), { version: '1.0.0' });
  writeJson(path.join(sourceRoot, 'manifests/install-modules.json'), {
    version: 1,
    modules: [{
      id: 'platform-configs', kind: 'platform', description: 'JSON merge fixture',
      paths: ['mcp-configs'], targets: ['cursor'], dependencies: [],
      defaultInstall: false, cost: 'light', stability: 'stable',
    }],
  });
  writeJson(path.join(sourceRoot, 'manifests/install-profiles.json'), {
    version: 1, profiles: { minimal: { description: 'Fixture', modules: ['platform-configs'] } },
  });
  writeJson(path.join(sourceRoot, '.mcp.json'), PAYLOAD);
  fs.mkdirSync(path.join(sourceRoot, 'mcp-configs'));
  fs.mkdirSync(homeDir);
  fs.mkdirSync(projectRoot);
  const initial = { mcpServers: { custom: { command: 'user-server' } }, metadata: { keep: 'user' } };
  writeJson(configPath, initial);
  const plan = createInstallPlanFromRequest({
    mode: 'manifest', target: 'cursor', profileId: null, moduleIds: ['platform-configs'],
    includeComponentIds: [], excludeComponentIds: [], hookConsent: 'declined',
  }, { sourceRoot, projectRoot, homeDir, env: {} });
  const lifecycle = { repoRoot: sourceRoot, projectRoot, homeDir, targets: ['cursor'], env: {} };
  return {
    initial, configPath, statePath,
    install: () => applyInstallPlan(plan),
    read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    write: value => writeJson(configPath, value),
    doctor: () => buildDoctorReport(lifecycle),
    repair: () => repairInstalledStates(lifecycle),
    uninstall: () => uninstallInstalledStates(lifecycle),
  };
}

function result(report) {
  assert.equal(report.results.length, 1);
  assert.notEqual(report.results[0].status, 'error', report.results[0].error);
  return report.results[0];
}

test('JSON merges retain new own __proto__ keys at every nesting level', () => {
  const patch = JSON.parse('{"__proto__":{"label":"top"},"nested":{"__proto__":{"label":"inner"}}}');
  const merged = deepMergeJson({ nested: {} }, patch);
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal(Object.getPrototypeOf(merged.nested), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), patch);
  assert.equal(Object.prototype.label, undefined);
});

test('existing own keys merge recursively while arrays replace without mutating inputs', () => {
  const base = JSON.parse('{"__proto__":{"keep":true},"constructor":{"keep":true},"items":[1,2]}');
  const patch = JSON.parse('{"__proto__":{"added":true},"constructor":{"added":true},"items":[3]}');
  const before = JSON.stringify(base);
  const merged = deepMergeJson(base, patch);
  assert.deepEqual(merged, JSON.parse('{"__proto__":{"keep":true,"added":true},"constructor":{"keep":true,"added":true},"items":[3]}'));
  assert.equal(JSON.stringify(base), before);
  assert.notEqual(merged.items, patch.items);
});

test('manifest installation records special JSON keys and uninstalls only managed values', t => {
  const f = fixture(t);
  f.install();
  const installed = f.read();
  assert.ok(Object.hasOwn(installed.metadata, '__proto__'));
  assert.deepEqual(installed.metadata.__proto__, { enabled: true });
  assert.equal(installed.metadata.keep, 'user');
  assert.equal(result(f.doctor()).status, 'ok');
  assert.equal(result(f.uninstall()).status, 'uninstalled');
  assert.deepEqual(f.read(), f.initial);
  assert.ok(!fs.existsSync(f.statePath));
});

test('repair restores missing own JSON keys while preserving user configuration', t => {
  const f = fixture(t);
  f.install();
  f.write(f.initial);
  assert.equal(result(f.repair()).status, 'repaired');
  assert.ok(Object.hasOwn(f.read().metadata, '__proto__'));
  assert.deepEqual(f.read().metadata.__proto__, { enabled: true });
  assert.equal(f.read().metadata.keep, 'user');
  assert.equal(result(f.doctor()).status, 'ok');
});

test('uninstall preserves user fields nested inside an own __proto__ property', t => {
  const f = fixture(t);
  f.install();
  const current = f.read();
  current.metadata = JSON.parse('{"keep":"user","__proto__":{"enabled":true,"userSetting":true},"constructor":{"label":"managed"}}');
  f.write(current);
  assert.equal(result(f.uninstall()).status, 'uninstalled');
  assert.deepEqual(f.read(), {
    ...f.initial,
    metadata: JSON.parse('{"keep":"user","__proto__":{"userSetting":true}}'),
  });
});
