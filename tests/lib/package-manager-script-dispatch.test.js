'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { getRunCommand, getCommandPattern } = require('../../scripts/lib/package-manager');

function withProject(manager, callback) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-script-dispatch-'));
  const previous = process.env.CLAUDE_PACKAGE_MANAGER;
  delete process.env.CLAUDE_PACKAGE_MANAGER;
  try {
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ packageManager: manager }));
    callback(project);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PACKAGE_MANAGER;
    else process.env.CLAUDE_PACKAGE_MANAGER = previous;
    fs.rmSync(project, { recursive: true, force: true });
  }
}

for (const manager of ['pnpm', 'yarn']) {
  test(`${manager} dispatches custom scripts explicitly, including built-in command names`, () => {
    withProject(manager, projectDir => {
      for (const name of ['list', 'add', 'config', 'lint']) {
        assert.equal(getRunCommand(name, { projectDir }), `${manager} run ${name}`);
      }
    });
  });

  test(`setup CLI advertises the unambiguous ${manager} script prefix`, () => {
    withProject(manager, projectDir => {
      const child = spawnSync(process.execPath, [
        path.resolve(__dirname, '../../scripts/setup-package-manager.js'), '--detect',
      ], { cwd: projectDir, encoding: 'utf8', env: { ...process.env }, timeout: 30000 });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(child.stdout.includes(`Run script: ${manager} run [script-name]`));
    });
  });
}

test('custom script recognition accepts generated and shorthand Yarn commands', () => {
  const matcher = new RegExp(`^${getCommandPattern('list')}$`);
  assert.ok(matcher.test('yarn run list'));
  assert.ok(matcher.test('yarn list'));
  assert.ok(matcher.test('pnpm run list'));
});

test('install and built-in workflow commands retain their existing contract', () => {
  for (const [manager, install, build] of [
    ['npm', 'npm install', 'npm run build'], ['pnpm', 'pnpm install', 'pnpm build'],
    ['yarn', 'yarn', 'yarn build'], ['bun', 'bun install', 'bun run build'],
  ]) {
    withProject(manager, projectDir => {
      assert.equal(getRunCommand('install', { projectDir }), install);
      assert.equal(getRunCommand('build', { projectDir }), build);
    });
  }
});
