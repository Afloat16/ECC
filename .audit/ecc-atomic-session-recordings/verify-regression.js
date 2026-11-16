'use strict';
const assert = require('assert');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const files = ['scripts/lib/atomic-write.js', 'scripts/lib/session-adapters/canonical-session.js'];
const base = '8abdf329ecbc9315dc4e3334a5702782f70b8b02';
const initial = '0083c6e8ec334e3875e621540ce62420f7a999d0';
const candidate = 'f314b2f2e309134ea48097f475276a3a6e14089d';
const testFile = 'tests/lib/session-recording-atomic.test.js';
if (process.platform !== 'win32') process.umask(0o022);
function restore(ref) {
  for (const file of files) {
    fs.writeFileSync(file, execFileSync('git', ['show', ref + ':' + file]));
    assert.strictEqual(execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim(),
      execFileSync('git', ['rev-parse', ref + ':' + file], { encoding: 'utf8' }).trim());
  }
}
assert.strictEqual(execFileSync('git', ['hash-object', testFile], { encoding: 'utf8' }).trim(),
  execFileSync('git', ['rev-parse', candidate + ':' + testFile], { encoding: 'utf8' }).trim());
const isWindows = process.platform === 'win32';
for (const [label, ref, expectedPassed, expectedFailed] of [
  ['baseline', base, isWindows ? 0 : 1, 4],
  ['initial-review-head', initial, 4, isWindows ? 0 : 1],
  ['candidate', candidate, isWindows ? 4 : 5, 0]
]) {
  restore(ref);
  const result = spawnSync(process.execPath, [testFile], { encoding: 'utf8' });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const match = result.stdout.match(/Passed: (\d+), Failed: (\d+)/);
  assert.ok(match, 'complete test summary');
  const passed = Number(match[1]), failed = Number(match[2]);
  assert.strictEqual(result.status, expectedFailed > 0 ? 1 : 0);
  assert.strictEqual(passed, expectedPassed);
  assert.strictEqual(failed, expectedFailed);
  console.log('ECC_RECORDING_PERMISSION_REGRESSION=' + JSON.stringify({ label, ref, platform: process.platform, node: process.version, passed, failed }));
}
