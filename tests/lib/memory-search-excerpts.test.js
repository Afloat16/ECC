'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const {
  MAX_RESULTS,
  resolveVaultRoots,
  searchMemories,
  serializeMemoryDocument,
} = require('../../scripts/lib/memory-vault');

const repository = path.resolve(__dirname, '../..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-memory-excerpts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  const roots = resolveVaultRoots({ cwd: root, homeDir: root, env: {} });
  const bodies = new Set();
  const env = {
    ...process.env,
    ECC_MEMORY_PROJECT_ROOT: path.join(root, '.ecc', 'memory'),
    ECC_MEMORY_USER_ROOT: path.join(root, 'user-memory'),
    ECC_MEMORY_HARNESS: 'claude',
    ECC_MEMORY_ALLOW_USER_SCOPE: '0',
  };
  function write(index, overrides = {}) {
    const memory = {
      schema: 'ecc.memory.v1', id: `mem_excerpt_${String(index).padStart(3, '0')}`,
      title: `Operational note ${index}`, kind: 'note', scope: 'project',
      trust: 'unreviewed', status: 'active', sourceHarness: 'codex',
      targetHarnesses: ['all'], tags: [], links: [],
      createdAt: '2026-07-26T20:00:00.000Z', updatedAt: '2026-07-26T20:00:00.000Z',
      body: `Note ${index}\n\n  Inspect readiness before shipping.\n`.repeat(12).trim(),
      ...overrides,
    };
    const directory = path.join(roots[memory.scope], `${memory.kind}s`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${memory.id}.md`), serializeMemoryDocument(memory));
    bodies.add(memory.body.trim());
    return memory;
  }
  return { root, roots, bodies, env, write };
}

// Observe the expensive full-body whitespace normalization at the public
// search boundary. Timing assertions would be sensitive to the host workload.
function searchWork(data, query, options = {}) {
  const replace = String.prototype.replace;
  const normalizedBodies = [];
  String.prototype.replace = function (pattern, replacement) {
    if (pattern instanceof RegExp && pattern.source === '\\s+' && pattern.flags === 'g'
        && replacement === ' ' && data.bodies.has(String(this))) {
      normalizedBodies.push(String(this));
    }
    return Reflect.apply(replace, this, [pattern, replacement]);
  };
  try {
    return {
      result: searchMemories(query, { roots: data.roots, ...options }),
      normalizedBodies,
    };
  } finally {
    String.prototype.replace = replace;
  }
}

for (const [query, limit, expectedCount] of [
  ['readiness', 5, 5],
  ['', 2, 2],
  ['absent-needle', 5, 0],
]) {
  test(`normalizes only returned excerpts for query ${JSON.stringify(query)}`, t => {
    const data = fixture(t);
    for (let i = 0; i < 32; i += 1) data.write(i);
    const { result, normalizedBodies } = searchWork(data, query, { limit });
    assert.equal(result.results.length, expectedCount);
    assert.equal(normalizedBodies.length, expectedCount);
    assert.equal(result.diagnostics.invalidFileCount, 0);
    assert.equal(result.diagnostics.truncated, false);
  });
}

test('applies the public result cap before formatting excerpts', t => {
  const data = fixture(t);
  for (let i = 0; i < MAX_RESULTS + 5; i += 1) data.write(i);
  const { result, normalizedBodies } = searchWork(data, '', { limit: MAX_RESULTS + 5 });
  assert.equal(result.results.length, MAX_RESULTS);
  assert.equal(normalizedBodies.length, MAX_RESULTS);
});

test('keeps score, timestamp and id ordering, filters, and exact excerpt text', t => {
  const data = fixture(t);
  const body = `${'a'.repeat(100)}\n\nনিরাপদ\t${'b'.repeat(300)}`;
  const lower = data.write(0, { body });
  const older = data.write(1, { title: 'নিরাপদ', body });
  const first = data.write(2, { title: 'নিরাপদ', body, updatedAt: '2026-07-27T20:00:00.000Z' });
  const second = data.write(3, { title: 'নিরাপদ', body, updatedAt: first.updatedAt });
  data.write(4, { title: 'নিরাপদ', body, status: 'superseded' });
  data.write(5, { title: 'নিরাপদ', body, targetHarnesses: ['codex'] });
  data.write(6, { title: 'নিরাপদ', body, kind: 'fact' });
  const { result, normalizedBodies } = searchWork(data, 'নিরাপদ', {
    limit: 3, kinds: ['note'], targetHarness: 'claude',
  });
  assert.deepEqual(result.results.map(item => item.memory.id), [first.id, second.id, older.id]);
  assert.deepEqual(result.results.map(item => item.score), [47, 47, 47]);
  assert.equal(result.results.some(item => item.memory.id === lower.id), false);
  assert.equal(normalizedBodies.length, 3);
  for (const item of result.results) {
    assert.equal(item.excerpt, `…${'a'.repeat(59)} নিরাপদ ${'b'.repeat(173)}…`);
    assert.equal(Object.hasOwn(item.memory, 'body'), false);
  }
});

test('still validates non-returned files and reports malformed documents', t => {
  const data = fixture(t);
  for (let i = 0; i < 5; i += 1) data.write(i);
  const badPath = path.join(data.roots.project, 'notes', 'mem_bad_document.md');
  fs.writeFileSync(badPath, 'not a memory document');
  const { result, normalizedBodies } = searchWork(data, 'absent-needle', { limit: 1 });
  assert.equal(result.results.length, 0);
  assert.equal(normalizedBodies.length, 0);
  assert.equal(result.diagnostics.invalidFileCount, 1);
  assert.equal(result.diagnostics.invalidFiles.length, 1);
  assert.equal(result.diagnostics.invalidFiles[0].path, 'project:notes/mem_bad_document.md');
  assert.ok(result.diagnostics.scannedBytes > 5 * 500);
  assert.equal(result.diagnostics.truncated, false);
});

test('public CLI preserves selected memory metadata and snippets', t => {
  const data = fixture(t);
  for (let i = 0; i < 16; i += 1) data.write(i);
  const expected = searchMemories('readiness', { roots: data.roots, limit: 3 });
  const child = spawnSync(process.execPath, [
    path.join(repository, 'scripts/ecc.js'), 'memory', 'search', 'readiness', '--limit', '3', '--json',
  ], { cwd: data.root, env: data.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(child.status, 0, child.stderr);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.schemaVersion, 'ecc.memory.search.v1');
  assert.deepEqual(actual.results, expected.results);
  assert.deepEqual(actual.diagnostics, expected.diagnostics);
});

test('stdio MCP search preserves the selected results and diagnostics', t => {
  const data = fixture(t);
  for (let i = 0; i < 16; i += 1) data.write(i);
  data.write(20, { targetHarnesses: ['codex'] });
  const expected = searchMemories('readiness', {
    roots: data.roots, limit: 3, targetHarness: 'claude',
  });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'excerpt-regression', version: '1.0.0' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'memory_search', arguments: { query: 'readiness', limit: 3 },
    } },
  ];
  const child = spawnSync(process.execPath, [path.join(repository, 'scripts/memory-mcp.mjs')], {
    cwd: data.root, env: data.env, encoding: 'utf8', timeout: 15000,
    input: `${messages.map(message => JSON.stringify(message)).join('\n')}\n`,
  });
  assert.equal(child.status, 0, child.stderr);
  const responses = child.stdout.trim().split('\n').map(line => JSON.parse(line));
  const response = responses.find(item => item.id === 2);
  assert.ok(response?.result, child.stdout);
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(JSON.parse(response.result.content[0].text), expected);
});
