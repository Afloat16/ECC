'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { trySymlink } = require('../lib/helpers/symlink-support');
const { serializeMemoryDocument } = require('../../scripts/lib/memory-vault');

const script = path.join(__dirname, '..', '..', 'scripts', 'memory.js');
let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
    failed += 1;
  }
}

function withVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-memory-diagnostics-'));
  try {
    fs.mkdirSync(path.join(root, '.git'));
    const vault = path.join(root, 'vault');
    const notes = path.join(vault, 'project', 'notes');
    fs.mkdirSync(notes, { recursive: true });
    const run = (query, json = false) => {
      const result = spawnSync(process.execPath, [
        script, 'search', query, '--scope', 'project', ...(json ? ['--json'] : []),
      ], {
        cwd: root,
        env: { ...process.env, ECC_MEMORY_PROJECT_ROOT: vault },
        encoding: 'utf8', timeout: 15000,
      });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(!result.stderr.includes(root), 'diagnostics must not expose filesystem paths');
      return result;
    };
    fn({ root, notes, run });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function addMemory(notes) {
  fs.writeFileSync(path.join(notes, 'memory.md'), serializeMemoryDocument({
    schema: 'ecc.memory.v1', id: 'mem_diagnostic_example', title: 'Quasar', kind: 'note',
    scope: 'project', trust: 'unreviewed', status: 'active', sourceHarness: 'claude',
    targetHarnesses: ['all'], tags: [], links: [], body: 'Quasar context.',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }));
}

for (const query of ['quasar', 'absent']) {
  test(`text search reports unreadable documents with query ${query}`, () => {
    withVault(({ notes, run }) => {
      addMemory(notes);
      fs.writeFileSync(path.join(notes, 'invalid.md'), 'not a memory document');
      const result = run(query);
      assert.match(result.stderr, /1 invalid or unreadable file/);
      assert.match(result.stderr, /ecc memory doctor/);
      assert.match(result.stdout, query === 'quasar' ? /mem_diagnostic_example/ : /No matching memories found/);
    });
  });
}

for (const query of ['quasar', 'absent']) {
  test(`text search discloses a real traversal depth limit with query ${query}`, () => {
    withVault(({ notes, run }) => {
      addMemory(notes);
      fs.mkdirSync(path.join(notes, ...Array(9).fill('nested')), { recursive: true });
      const result = run(query);
      assert.match(result.stderr, /scan limit reached/);
      assert.match(result.stdout, query === 'quasar' ? /mem_diagnostic_example/ : /No matching memories found/);
    });
  });
}

test('text diagnostics use the total count when the detailed list is capped', () => {
  withVault(({ notes, run }) => {
    for (let i = 0; i < 101; i += 1) {
      fs.writeFileSync(path.join(notes, `invalid-${i}.md`), 'invalid');
    }
    const result = run('absent');
    assert.match(result.stderr, /101 invalid or unreadable files/);
    assert.strictEqual(result.stderr.split('\n').filter(Boolean).length, 1);
  });
});

test('skipped symlinks are visible without exposing their targets', () => {
  withVault(({ root, notes, run }) => {
    const target = path.join(root, 'outside.md');
    fs.writeFileSync(target, 'private context');
    if (!trySymlink(target, path.join(notes, 'link.md'), 'file')) {
      skipped += 1;
      return;
    }
    const result = run('absent');
    assert.match(result.stderr, /1 skipped symlink/);
    assert.ok(!result.stderr.includes('outside.md'));
  });
});

test('JSON retains structured diagnostics and adds no stderr message', () => {
  withVault(({ notes, run }) => {
    addMemory(notes);
    fs.writeFileSync(path.join(notes, 'invalid.md'), 'invalid');
    fs.mkdirSync(path.join(notes, ...Array(9).fill('nested')), { recursive: true });
    const result = run('quasar', true);
    assert.strictEqual(result.stderr, '');
    const payload = JSON.parse(result.stdout);
    assert.strictEqual(payload.schemaVersion, 'ecc.memory.search.v1');
    assert.strictEqual(payload.results[0].memory.id, 'mem_diagnostic_example');
    assert.strictEqual(payload.diagnostics.truncated, true);
    assert.strictEqual(payload.diagnostics.invalidFileCount, 1);
    assert.strictEqual(payload.diagnostics.invalidFiles[0].path, 'project:notes/invalid.md');
  });
});

test('complete searches stay quiet for both empty and nonempty results', () => {
  withVault(({ notes, run }) => {
    addMemory(notes);
    assert.strictEqual(run('quasar').stderr, '');
    const missing = run('absent');
    assert.strictEqual(missing.stderr, '');
    assert.strictEqual(missing.stdout, 'No matching memories found.\n');
  });
});

console.log(`\nPassed: ${passed}`);
console.log(`Skipped: ${skipped}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
