'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parseInstallArgs } = require('../../scripts/lib/install/request');

const VALUE_FLAGS = [
  '--target', '--config', '--profile', '--modules', '--with', '--without',
  '--skill', '--skills', '--locale', '--consent-mcp', '--source-sha',
];

for (const suffix of [[], [''], ['  '], ['--dry-run'], ['--no-hooks'], ['-h']]) {
  test(`all install value flags reject ${JSON.stringify(suffix)} without consuming it`, () => {
    for (const flag of VALUE_FLAGS) {
      assert.throws(
        () => parseInstallArgs(['node', 'install-apply.js', flag, ...suffix]),
        { message: `Missing value for ${flag}` },
        flag,
      );
    }
  });
}

test('valid values preserve subsequent dry-run and hook choices', () => {
  const parsed = parseInstallArgs([
    'node', 'install-apply.js', '--target', 'claude', '--config', './-config.json',
    '--modules', 'rules-core', '--with', 'lang:python', '--without', 'lang:go',
    '--skill', 'tdd-workflow', '--skills', 'security-review,python-patterns',
    '--consent-mcp', 'server-a,server-b', '--dry-run', '--no-hooks',
  ]);
  assert.equal(parsed.configPath, './-config.json');
  assert.deepEqual(parsed.moduleIds, ['rules-core']);
  assert.deepEqual(parsed.consentMcp, ['server-a', 'server-b']);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.noHooks, true);
});

for (const missingValue of [true, false]) {
  test(`public installer ${missingValue ? 'rejects a missing MCP value' : 'preserves a valid dry-run'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-install-required-'));
    const project = path.join(root, 'project');
    const home = path.join(root, 'home');
    fs.mkdirSync(project);
    fs.mkdirSync(home);
    try {
      const child = spawnSync(process.execPath, [
        path.resolve(__dirname, '../../scripts/install-apply.js'),
        '--target', 'mistral-vibe', '--skills', 'tdd-workflow',
        ...(missingValue ? ['--consent-mcp'] : []), '--dry-run', '--json',
      ], {
        cwd: project,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, HOME: home, USERPROFILE: home, ECC_DRY_RUN: '0' },
      });
      if (missingValue) {
        assert.equal(child.status, 1, child.stderr);
        assert.match(child.stderr, /Missing value for --consent-mcp/);
      } else {
        assert.equal(child.status, 0, child.stderr);
        const { dryRun, plan } = JSON.parse(child.stdout);
        assert.equal(dryRun, true);
        assert.equal(plan.applied, false);
        assert.ok(plan.operations.length > 0);
      }
      assert.deepEqual(fs.readdirSync(project), []);
      assert.deepEqual(fs.readdirSync(home), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
