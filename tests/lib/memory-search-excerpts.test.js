'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { resolveVaultRoots, saveMemory, searchMemories } = require('../../scripts/lib/memory-vault');

function createVault(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-search-excerpts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '.git'));
  const roots = resolveVaultRoots({ cwd: directory, homeDir: directory, env: {} });
  const bodies = new Set();
  for (let index = 0; index < 160; index += 1) {
    const body = `Vault document ${index}.\n${'Review   the\nprevious decision. '.repeat(200)}`
      + (index < 32 ? 'Rotation checklist for the next release.\n' : 'Historical release notes.\n')
      + `${'Keep\tall historical details.\n'.repeat(1000)}End of document.`;
    const saved = saveMemory({
      id: `mem_search_${String(index).padStart(4, '0')}`,
      title: index < 3 ? 'Rotation plan' : `Archive entry ${index}`,
      body,
      targetHarnesses: index === 1 ? ['codex'] : ['all'],
    }, {
      roots,
      now: () => index < 2 ? '2026-11-11T12:00:00.000Z' : '2026-11-10T12:00:00.000Z',
    });
    bodies.add(saved.memory.body);
  }
  fs.writeFileSync(path.join(roots.project, 'notes', 'invalid.md'), 'Not a memory document.\n');
  return { roots, bodies };
}

function countBodyNormalizations(bodies, action) {
  const originalReplace = String.prototype.replace;
  let count = 0;
  // Count full-body whitespace normalization, rather than asserting a machine-
  // dependent runtime. All vault reads, parsing, filtering and ranking stay real.
  String.prototype.replace = function (pattern, replacement) {
    if (pattern instanceof RegExp && pattern.source === '\\s+' && pattern.global
      && replacement === ' ' && bodies.has(String(this))) count += 1;
    return originalReplace.call(this, pattern, replacement);
  };
  try {
    return { value: action(), count };
  } finally {
    String.prototype.replace = originalReplace;
  }
}

test('large-vault searches build excerpts only for returned results', async t => {
  const { roots, bodies } = createVault(t);
  const complete = searchMemories('rotation', { roots, limit: 100 });
  assert.equal(complete.results.length, 32);
  assert.deepEqual(complete.results.slice(0, 3).map(result => result.memory.id), [
    'mem_search_0000', 'mem_search_0001', 'mem_search_0002',
  ]);
  assert.equal(complete.results[0].score, 29);
  assert.match(complete.results[0].excerpt, /^….*Rotation checklist.*…$/);
  assert.ok(complete.diagnostics.scannedBytes > 5 * 1024 * 1024);
  assert.equal(complete.diagnostics.invalidFileCount, 1);
  assert.equal(complete.diagnostics.truncated, false);

  await t.test('ranked limits preserve results and diagnostics', () => {
    const measured = countBodyNormalizations(bodies, () => searchMemories('rotation', { roots, limit: 3 }));
    assert.deepEqual(measured.value, { ...complete, results: complete.results.slice(0, 3) });
    assert.equal(measured.count, 3, 'only the three returned bodies need excerpt normalization');
  });

  await t.test('no-match searches perform no excerpt work', () => {
    const measured = countBodyNormalizations(bodies, () => searchMemories('unfindableword', { roots }));
    assert.deepEqual(measured.value, { ...complete, results: [] });
    assert.equal(measured.count, 0, 'unmatched memories do not need excerpts');
  });

  await t.test('empty queries keep date and ID ordering without excerpting the whole vault', () => {
    const measured = countBodyNormalizations(bodies, () => searchMemories('', { roots, limit: 2 }));
    assert.deepEqual(measured.value.results.map(result => result.memory.id), ['mem_search_0000', 'mem_search_0001']);
    assert.ok(measured.value.results.every(result => result.score === 0 && result.excerpt.startsWith('Vault document')));
    assert.deepEqual(measured.value.diagnostics, complete.diagnostics);
    assert.equal(measured.count, 2);
  });

  await t.test('harness filtering preserves the selected excerpts', () => {
    const measured = countBodyNormalizations(bodies, () => searchMemories('rotation', {
      roots, targetHarness: 'claude', limit: 2,
    }));
    assert.deepEqual(measured.value, { ...complete, results: [complete.results[0], complete.results[2]] });
    assert.equal(measured.count, 2);
  });
});
