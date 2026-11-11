'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getRunCommand, getExecCommand } = require('../../scripts/lib/package-manager');

test('generates commands for colon-separated package script names', () => {
  const previous = process.env.CLAUDE_PACKAGE_MANAGER;
  try {
    for (const [manager, prefix] of [
      ['npm', 'npm run'], ['pnpm', 'pnpm'], ['yarn', 'yarn'], ['bun', 'bun run'],
    ]) {
      process.env.CLAUDE_PACKAGE_MANAGER = manager;
      assert.equal(getRunCommand('test:unit'), `${prefix} test:unit`);
      assert.equal(getRunCommand('build:client:prod'), `${prefix} build:client:prod`);
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PACKAGE_MANAGER;
    else process.env.CLAUDE_PACKAGE_MANAGER = previous;
  }
});

test('continues rejecting shell syntax in script names', () => {
  for (const name of ['test:unit;echo bad', 'test:unit && echo bad', 'test:unit\necho bad', 'test:$(id)']) {
    assert.throws(() => getRunCommand(name), /unsafe characters/);
  }
});

test('does not broaden executable package names with script-only punctuation', () => {
  assert.throws(() => getExecCommand('test:unit'), /unsafe characters/);
});
