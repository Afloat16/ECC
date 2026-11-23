'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const codex = require('../../scripts/lib/install-targets/codex-home');
const { planInstallTargetScaffold } = require('../../scripts/lib/install-targets/registry');
const { createInstallPlanFromRequest } = require('../../scripts/lib/install/runtime');
const { applyInstallPlan } = require('../../scripts/lib/install/apply');

const REPO_ROOT = path.resolve(__dirname, '../..');
const INSTALL_ARGS = ['--target', 'codex', '--modules', 'platform-configs', '--no-hooks', '--json'];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const codexHome = path.join(root, 'profiles', 'Codex home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  // Pass runtime/coverage settings, not the caller's config and data roots.
  const env = Object.fromEntries([
    'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC',
    'TMPDIR', 'TEMP', 'TMP', 'NODE_V8_COVERAGE',
  ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return {
    root, homeDir, projectRoot, codexHome,
    env: { ...env, HOME: homeDir, USERPROFILE: homeDir, CODEX_HOME: codexHome },
  };
}

function run(f, script, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: f.projectRoot,
    env: f.env,
    encoding: 'utf8',
    timeout: process.platform === 'win32' ? 60000 : 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, expectedStatus, result.stderr || result.error?.message || result.stdout);
  return JSON.parse(result.stdout);
}

function assertContained(root, destinations) {
  assert.ok(destinations.length > 0);
  for (const destination of destinations) {
    const relative = path.relative(root, destination);
    assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), destination);
  }
}

test('Codex scaffold, state, and trusted roots follow the invocation CODEX_HOME', t => {
  const f = fixture(t);
  const input = { homeDir: f.homeDir, env: { CODEX_HOME: f.codexHome } };
  const plan = planInstallTargetScaffold({
    ...input, target: 'codex', repoRoot: REPO_ROOT,
    modules: [{ id: 'platform-configs', paths: ['.codex', 'mcp-configs'] }],
  });
  assert.equal(plan.targetRoot, f.codexHome);
  assert.equal(plan.installStatePath, path.join(f.codexHome, 'ecc-install-state.json'));
  assert.deepEqual(plan.trustedRoots, [f.codexHome]);
  assertContained(f.codexHome, plan.operations.map(operation => operation.destinationPath));
  assert.equal(codex.resolveDestinationPath('.codex', input), f.codexHome);
  assert.ok(plan.operations.some(operation => (
    operation.sourceRelativePath === '.codex/user-config.example.toml'
    && operation.destinationPath === path.join(f.codexHome, 'config.toml')
  )));
});

test('absent, empty, and non-string CODEX_HOME keep the existing default', t => {
  const f = fixture(t);
  for (const env of [{}, null, { CODEX_HOME: '' }, { CODEX_HOME: null }, { CODEX_HOME: 42 }]) {
    const input = { homeDir: f.homeDir, env };
    assert.equal(codex.resolveRoot(input), path.join(f.homeDir, '.codex'));
    assert.equal(codex.getInstallStatePath(input), path.join(f.homeDir, '.codex', 'ecc-install-state.json'));
  }
});

test('configured path bytes are preserved and relative roots become absolute', t => {
  const f = fixture(t);
  for (const configured of ['profiles/../selected home', path.join(f.root, ' trailing space ')]) {
    assert.equal(codex.resolveRoot({ homeDir: f.homeDir, env: { CODEX_HOME: configured } }), path.resolve(configured));
  }
});

test('explicit invocation homes remain isolated from ambient CODEX_HOME', t => {
  const f = fixture(t);
  const script = [
    `const adapter = require(${JSON.stringify(path.join(REPO_ROOT, 'scripts/lib/install-targets/codex-home'))});`,
    'const homeDir = process.env.HOME;',
    'console.log(JSON.stringify([adapter.resolveRoot(), adapter.resolveRoot({ homeDir }),',
    'adapter.resolveRoot({ homeDir, env: {} }), adapter.resolveRoot({ homeDir, env: process.env })]));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    f.codexHome, path.join(f.homeDir, '.codex'), path.join(f.homeDir, '.codex'), f.codexHome,
  ]);
});

for (const relative of [false, true]) {
  test(`public plan and dry-run use ${relative ? 'relative' : 'absolute'} CODEX_HOME without writing`, t => {
    const f = fixture(t);
    if (relative) f.env.CODEX_HOME = path.relative(f.projectRoot, f.codexHome);
    const plan = run(f, 'install-plan.js', ['--target', 'codex', '--modules', 'platform-configs', '--json']);
    const preview = run(f, 'install-apply.js', [...INSTALL_ARGS, '--dry-run']);
    assert.equal(plan.targetRoot, f.codexHome);
    assert.equal(preview.plan.installRoot, f.codexHome);
    assert.equal(plan.installStatePath, preview.plan.installStatePath);
    assertContained(f.codexHome, plan.operations.map(operation => operation.destinationPath));
    assertContained(f.codexHome, preview.plan.operations.map(operation => operation.destinationPath));
    assert.equal(fs.existsSync(f.codexHome), false);
    assert.equal(fs.existsSync(path.join(f.homeDir, '.codex')), false);
  });
}

test('public install, status, doctor, repair, and uninstall stay within the selected Codex home', t => {
  const f = fixture(t);
  // A second real managed installation must survive maintenance of this profile.
  applyInstallPlan(createInstallPlanFromRequest({
    mode: 'manifest', target: 'codex', profileId: null, moduleIds: ['platform-configs'],
    includeComponentIds: [], excludeComponentIds: [], hookConsent: 'declined',
  }, { sourceRoot: REPO_ROOT, projectRoot: f.projectRoot, homeDir: f.homeDir, env: {} }));
  const defaultRoot = path.join(f.homeDir, '.codex');
  const defaultFiles = ['ecc-install-state.json', 'config.toml', 'AGENTS.md'];
  const originalDefault = defaultFiles.map(name => fs.readFileSync(path.join(defaultRoot, name)));
  const assertDefaultUnchanged = () => defaultFiles.forEach((name, index) => {
    assert.deepEqual(fs.readFileSync(path.join(defaultRoot, name)), originalDefault[index]);
  });

  const installed = run(f, 'install-apply.js', INSTALL_ARGS);
  const statePath = path.join(f.codexHome, 'ecc-install-state.json');
  const instructions = path.join(f.codexHome, 'AGENTS.md');
  assert.equal(installed.result.installRoot, f.codexHome);
  assert.equal(installed.result.installStatePath, statePath);
  assert.equal(fs.existsSync(statePath), true);
  assert.deepEqual(fs.readFileSync(path.join(f.codexHome, 'config.toml')),
    fs.readFileSync(path.join(REPO_ROOT, '.codex/user-config.example.toml')));
  assertDefaultUnchanged();

  const status = run(f, 'status.js', ['--json']);
  assert.equal(status.installHealth.installations.length, 1);
  assert.equal(status.installHealth.installations[0].targetRoot, f.codexHome);
  assert.equal(run(f, 'doctor.js', ['--target', 'codex', '--json']).summary.errorCount, 0);

  const originalInstructions = fs.readFileSync(instructions);
  fs.unlinkSync(instructions);
  assert.ok(run(f, 'doctor.js', ['--target', 'codex', '--json'], 1).summary.errorCount > 0);
  const repaired = run(f, 'repair.js', ['--target', 'codex', '--json']);
  assert.equal(repaired.summary.repairedCount, 1);
  assert.deepEqual(fs.readFileSync(instructions), originalInstructions);
  assert.equal(run(f, 'doctor.js', ['--target', 'codex', '--json']).summary.errorCount, 0);

  const userNote = path.join(f.codexHome, 'personal-note.txt');
  fs.writeFileSync(userNote, 'Keep this profile note.\n');
  run(f, 'uninstall.js', ['--target', 'codex', '--dry-run', '--json']);
  assert.equal(fs.existsSync(statePath), true);
  assert.equal(fs.existsSync(instructions), true);
  assert.equal(run(f, 'uninstall.js', ['--target', 'codex', '--json']).summary.uninstalledCount, 1);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(instructions), false);
  assert.equal(fs.readFileSync(userNote, 'utf8'), 'Keep this profile note.\n');
  assertDefaultUnchanged();
});
