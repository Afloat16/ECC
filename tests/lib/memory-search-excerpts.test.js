'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveVaultRoots,
  searchMemories,
  serializeMemoryDocument,
} = require('../../scripts/lib/memory-vault');

let passed = 0;
let failed = 0;
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

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-memory-search-excerpts-'));
fs.mkdirSync(path.join(fixture, '.git'));
const roots = resolveVaultRoots({ cwd: fixture, homeDir: fixture, env: {} });
const notes = path.join(roots.project, 'notes');
fs.mkdirSync(notes, { recursive: true });
const longBody = `${'intro\t'.repeat(20)}Quasar\n${'tail '.repeat(80)}`;
const documents = [
  ['alpha', 'Quasar older', longBody, '2026-01-01T00:00:00.000Z', ['codex']],
  ['beta', 'Quasar newer', longBody, '2026-02-01T00:00:00.000Z', ['all']],
  ['gamma', 'Quasar newer', 'Quasar short body.', '2026-02-01T00:00:00.000Z', ['all']],
  ['body', 'Background', longBody, '2026-01-01T00:00:00.000Z', ['all']],
  ['unrelated', 'Different topic', 'No matching context.', '2026-01-01T00:00:00.000Z', ['all']],
].map(([id, title, body, updatedAt, targetHarnesses]) => ({
  schema: 'ecc.memory.v1', id: `mem_excerpt_${id}`, title, kind: 'note', scope: 'project',
  trust: 'unreviewed', status: 'active', sourceHarness: 'claude', targetHarnesses,
  tags: [], links: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt, body,
}));
const before = documents.map(memory => {
  const file = path.join(notes, `${memory.id}.md`);
  const content = serializeMemoryDocument(memory);
  fs.writeFileSync(file, content);
  return { file, content };
});
const options = { roots, scopes: ['project'] };

try {
  test('limits results after score, timestamp and ID ordering without losing excerpts', () => {
    const all = searchMemories('quasar', { ...options, limit: 20 });
    const limited = searchMemories('quasar', { ...options, limit: 2 });
    assert.deepStrictEqual(all.results.map(result => result.memory.id), [
      'mem_excerpt_beta', 'mem_excerpt_gamma', 'mem_excerpt_alpha', 'mem_excerpt_body',
    ]);
    assert.deepStrictEqual(limited.results, all.results.slice(0, 2));
    assert.deepStrictEqual(limited.diagnostics, all.diagnostics);
    assert.ok(limited.results[0].excerpt.startsWith('…'));
    assert.ok(limited.results[0].excerpt.includes('Quasar'));
    assert.ok(limited.results[0].excerpt.endsWith('…'));
    assert.strictEqual(limited.results[0].excerpt.length, 242);
    assert.strictEqual(/[\n\t]/.test(limited.results[0].excerpt), false);
    assert.strictEqual(limited.results[1].excerpt, 'Quasar short body.');
    assert.ok(limited.results.every(result => !Object.hasOwn(result.memory, 'body')));
  });

  test('empty queries retain newest-first ordering and the initial body excerpt', () => {
    const result = searchMemories('', { ...options, limit: 1 }).results[0];
    assert.strictEqual(result.memory.id, 'mem_excerpt_beta');
    assert.strictEqual(result.score, 0);
    assert.ok(result.excerpt.startsWith('intro intro'));
    assert.ok(result.excerpt.endsWith('…'));
    assert.strictEqual(result.excerpt.length, 241);
  });

  test('harness filtering happens before the result limit', () => {
    const result = searchMemories('quasar', { ...options, targetHarness: 'claude', limit: 3 });
    assert.deepStrictEqual(result.results.map(entry => entry.memory.id), [
      'mem_excerpt_beta', 'mem_excerpt_gamma', 'mem_excerpt_body',
    ]);
  });

  test('unmatched queries still retain invalid-document diagnostics', () => {
    fs.writeFileSync(path.join(notes, 'invalid.md'), 'not a memory document');
    const result = searchMemories('absent-phrase', { ...options, limit: 1 });
    assert.deepStrictEqual(result.results, []);
    assert.strictEqual(result.diagnostics.invalidFileCount, 1);
    assert.strictEqual(result.diagnostics.invalidFiles[0].code, 'invalid-document');
    assert.strictEqual(result.diagnostics.truncated, false);
  });

  test('search and excerpt generation leave stored documents untouched', () => {
    for (const { file, content } of before) {
      assert.strictEqual(fs.readFileSync(file, 'utf8'), content);
    }
  });
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
