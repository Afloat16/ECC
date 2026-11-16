'use strict';
const assert = require('assert');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const files = ['scripts/lib/session-aliases.js'];
const base = '8abdf329ecbc9315dc4e3334a5702782f70b8b02';
const candidate = 'b504f3cdd73090dc9f4f51b8ebacf8bb5777c641';
const testFile = 'tests/lib/session-aliases-own-keys.test.js';
function restore(ref) {
  for (const file of files) {
    const source = execFileSync('git', ['show', ref + ':' + file]);
    fs.writeFileSync(file, source);
    assert.strictEqual(execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim(),
      execFileSync('git', ['rev-parse', ref + ':' + file], { encoding: 'utf8' }).trim());
  }
}
assert.strictEqual(execFileSync('git', ['hash-object', testFile], { encoding: 'utf8' }).trim(),
  execFileSync('git', ['rev-parse', candidate + ':' + testFile], { encoding: 'utf8' }).trim());
for (const [label, ref] of [['baseline', base], ['candidate', candidate]]) {
  restore(ref);
  const result = spawnSync(process.execPath, [testFile], { encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const match = result.stdout.match(/Passed: (\d+), Failed: (\d+)/);
  assert.ok(match, 'complete test summary');
  const passed = Number(match[1]);
  const failed = Number(match[2]);
  const expectedPass = 2;
  assert.strictEqual(result.status, label === 'baseline' ? 1 : 0);
  assert.strictEqual(failed, label === 'baseline' ? 15 : 0);
  assert.strictEqual(passed, label === 'baseline' ? expectedPass : expectedPass + 15);
  console.log('ECC_ALIAS_REGRESSION=' + JSON.stringify({ label, ref, platform: process.platform, node: process.version, passed, failed }));
}
