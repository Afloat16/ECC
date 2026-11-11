'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const script = path.resolve(__dirname, '../../scripts/memory.js');

for (const stalled of [false, true]) {
  test(`memory save handles stdin progress with an idle retry budget (stalled=${stalled})`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-memory-progress-'));
    const preload = path.join(root, 'stdin-fixture.cjs');
    const statsPath = path.join(root, 'stdin-stats.json');
    const chunks = ['First part. ', 'Second part. ', 'Last part.'];
    const env = { ...process.env, HOME: root, USERPROFILE: root, ECC_DRY_RUN: '0',
      ECC_MEMORY_PROJECT_ROOT: path.join(root, 'memory'), ECC_MEMORY_USER_ROOT: path.join(root, 'user-memory') };
    try {
      fs.writeFileSync(preload, `
        const fs = require('node:fs');
        const read = fs.readSync;
        const chunks = ${JSON.stringify(chunks)};
        let chunk = 0;
        let retries = 0;
        let waited = 0;
        Atomics.wait = (_signal, _index, _expected, milliseconds) => { waited += milliseconds; return 'timed-out'; };
        fs.readSync = (descriptor, buffer, ...args) => {
          if (descriptor !== 0) return read(descriptor, buffer, ...args);
          if (chunk === chunks.length) return 0;
          if (retries++ < 300 || (${stalled} && chunk === 1)) {
            const error = new Error('input temporarily unavailable');
            error.code = 'EAGAIN';
            throw error;
          }
          retries = 0;
          return buffer.write(chunks[chunk++]);
        };
        process.on('exit', () => fs.writeFileSync(${JSON.stringify(statsPath)}, JSON.stringify({ chunk, waited })));
      `);
      const saved = spawnSync(process.execPath, ['--require', preload, script, 'save', '--title', 'Slow input', '--stdin', '--json'], {
        cwd: root, env, encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(saved.error);
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      if (stalled) {
        assert.equal(saved.status, 1);
        assert.match(saved.stderr, /Standard input remained unavailable after 5000ms/);
        assert.deepEqual(stats, { chunk: 1, waited: 8000 });
        assert.equal(fs.existsSync(path.join(root, 'memory', 'project', 'notes')), false);
      } else {
        assert.equal(saved.status, 0, saved.stderr);
        assert.deepEqual(stats, { chunk: 3, waited: 9000 });
        const payload = JSON.parse(saved.stdout);
        const recalled = spawnSync(process.execPath, [script, 'read', payload.memory.id, '--json'], {
          cwd: root, env, encoding: 'utf8', timeout: 15000,
        });
        assert.equal(recalled.status, 0, recalled.stderr);
        assert.equal(JSON.parse(recalled.stdout).memory.body, chunks.join(''));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
