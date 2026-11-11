'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveVaultRoots, saveMemory } = require('../../scripts/lib/memory-vault');

const memoryScript = path.resolve(__dirname, '../../scripts/memory.js');
const router = path.resolve(__dirname, '../../scripts/ecc.js');

for (const problem of ['invalid', 'duplicate', 'broken-link', 'healthy', 'empty']) {
  test(`memory doctor exit status matches its ${problem} vault report`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-memory-doctor-exit-'));
    const env = { ...process.env, HOME: root, USERPROFILE: root, ECC_DRY_RUN: '0',
      ECC_MEMORY_PROJECT_ROOT: path.join(root, 'memory'), ECC_MEMORY_USER_ROOT: path.join(root, 'user-memory') };
    try {
      if (problem !== 'empty') {
        const roots = resolveVaultRoots({ cwd: root, homeDir: root, env });
        const saved = saveMemory({ title: 'Doctor fixture', body: 'A local memory.',
          ...(problem === 'broken-link' ? { links: ['mem_missing_target'] } : {}) }, { roots });
        if (problem === 'invalid') fs.writeFileSync(saved.path, 'incomplete document\n');
        if (problem === 'duplicate') fs.copyFileSync(saved.path, path.join(path.dirname(saved.path), 'duplicate.md'));
      }
      const healthy = ['healthy', 'empty'].includes(problem);
      for (const prefix of [[memoryScript], [router, 'memory']]) {
        for (const json of [false, true]) {
          const result = spawnSync(process.execPath, [...prefix, 'doctor', ...(json ? ['--json'] : [])], {
            cwd: root, env, encoding: 'utf8', timeout: 15000,
          });
          assert.ifError(result.error);
          assert.equal(result.status, healthy ? 0 : 1, `${prefix.join(' ')} (json=${json}): ${result.stdout}${result.stderr}`);
          assert.equal(result.stderr, '');
          if (json) {
            const report = JSON.parse(result.stdout);
            assert.equal(report.schemaVersion, 'ecc.memory.doctor.v1');
            assert.equal(report.ok, healthy);
            const count = { invalid: 'invalidFileCount', duplicate: 'duplicateIdCount', 'broken-link': 'brokenLinkCount' }[problem];
            if (count) assert.equal(report[count], 1);
          } else {
            assert.match(result.stdout, healthy ? /ECC memory doctor: PASS/ : /ECC memory doctor: ISSUES FOUND/);
          }
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
