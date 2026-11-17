'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collectResources, buildInventory } = require('../../scripts/lib/coordination-inventory');

const tasks = [{ id: 'finished-worker', pid: 2147483647 }];
const emptySelection = () => Object.assign(new Error('ps exited with no selected processes'), {
  status: 1, signal: null, stdout: '', stderr: '',
});

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: an empty ps selection is a completed observation`, () => {
    const resources = collectResources(tasks, {
      platform,
      totalmem: () => 1024,
      freemem: () => 512,
      execFileSync: () => { throw emptySelection(); },
    });
    assert.equal(resources.processStatus, 'ok');
    assert.deepEqual(resources.processes, []);
    assert.equal(resources.memory.freeBytes, 512);
    const report = buildInventory({ version: 1, tasks: [...tasks, { id: 'no-pid' }] }, { resources });
    assert.equal(report.tasks[0].process.state, 'not-observed');
    assert.equal(report.tasks[1].process.state, 'unknown');
    assert.ok(report.limits.includes('Stale heartbeat is not proof of a stuck process; PID reuse is not resolved.'));
  });
}

for (const [name, changes] of [
  ['diagnostic output', { stderr: 'ps: permission denied\n' }],
  ['unexpected process rows', { stdout: '2147483647 1 32 00:01 S\n' }],
  ['whitespace diagnostics', { stderr: '\n' }],
  ['invalid command exit', { status: 2 }],
  ['terminated probe', { signal: 'SIGTERM' }],
  ['unknown exit status', { status: null }],
  ['missing stdout', { stdout: undefined }],
  ['missing stderr', { stderr: undefined }],
  ['missing signal metadata', { signal: undefined }],
]) {
  test(`failed ps probes remain unavailable: ${name}`, () => {
    const resources = collectResources(tasks, {
      platform: 'linux',
      execFileSync: () => { throw Object.assign(emptySelection(), changes); },
    });
    assert.equal(resources.processStatus, 'unavailable');
    assert.deepEqual(resources.processes, []);
    const report = buildInventory({ version: 1, tasks }, { resources });
    assert.equal(report.tasks[0].process.state, 'unknown');
  });
}

test('non-Error probe failures remain unavailable', () => {
  const resources = collectResources(tasks, {
    platform: 'linux',
    execFileSync: () => { throw null; },
  });
  assert.equal(resources.processStatus, 'unavailable');
});

test('live CLI reports no selected PIDs while preserving the manifest', {
  skip: !['linux', 'darwin'].includes(process.platform),
}, () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-empty-processes-'));
  try {
    const file = path.join(fixture, 'manifest.json');
    const manifest = JSON.stringify({ version: 1, tasks });
    fs.writeFileSync(file, manifest);
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../scripts/coordination-inventory.js'), '--manifest', file, '--live',
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(report.resources.processStatus, 'ok');
    assert.deepEqual(report.resources.processes, []);
    assert.equal(report.tasks[0].process.state, 'not-observed');
    assert.equal(fs.readFileSync(file, 'utf8'), manifest);

    const mixedTasks = [...tasks, { id: 'running-worker', pid: process.pid }];
    const mixedResources = collectResources(mixedTasks);
    assert.equal(mixedResources.processStatus, 'ok');
    const mixed = buildInventory({ version: 1, tasks: mixedTasks }, { resources: mixedResources });
    assert.equal(mixed.tasks[0].process.state, 'not-observed');
    assert.equal(mixed.tasks[1].process.state, 'observed');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
