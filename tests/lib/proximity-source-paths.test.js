'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { buildDependencyGraph, buildDependencyGraphFromSources, scanAirspace } = require('../../scripts/lib/agent-proximity');

const sources = Object.freeze({
  'app/main.ts': "import { value } from '../lib/shared.js';",
  'lib/shared.ts': "export { value } from './detail';",
  'lib/detail/index.js': 'export const value = 1;'
});
const backslashes = Object.freeze(Object.fromEntries(Object.entries(sources).map(([file, source]) =>
  [file.replace(/\//g, '\\'), source])));

test('Windows source-map keys retain the same graph as slash-separated keys', () => {
  assert.deepEqual(buildDependencyGraphFromSources(backslashes), buildDependencyGraphFromSources(sources));
});

test('the public airspace scan retains dependency advisories for Windows source maps', () => {
  const agents = [
    { agentId: 'caller', files: [{ path: 'app\\main.ts' }] },
    { agentId: 'library', files: [{ path: 'lib\\shared.ts' }] }
  ];
  const graph = buildDependencyGraphFromSources(backslashes);
  const scan = scanAirspace(agents, graph);
  assert.equal(scan.links[0].channels.dependency, 1);
  assert.ok(scan.advisories.length > 0);
  assert.deepEqual(graph.adjacency['lib/shared.ts'], ['lib/detail/index.js']);
});

test('mixed source key separators agree with the filesystem graph', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-proximity-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(sources)) {
    const destination = path.join(dir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
  }
  const mixed = Object.freeze({ 'app\\main.ts': sources['app/main.ts'],
    'lib/shared.ts': sources['lib/shared.ts'], 'lib\\detail/index.js': sources['lib/detail/index.js'] });
  assert.deepEqual(buildDependencyGraphFromSources(mixed), buildDependencyGraph(dir, Object.keys(sources)));
});

test('normalization does not modify frozen input or lose null-prototype own entries', () => {
  const input = Object.freeze(Object.assign(Object.create(null), {
    'constructor\\entry.js': "require('../constructor/value.js')", 'constructor/value.js': ''
  }));
  const before = Object.entries(input);
  assert.deepEqual(buildDependencyGraphFromSources(input).adjacency['constructor/entry.js'], ['constructor/value.js']);
  assert.deepEqual(Object.entries(input), before);
  assert.equal(Object.getPrototypeOf(input), null);
});

test('empty sources and unresolved imports retain their current behavior', () => {
  assert.deepEqual(buildDependencyGraphFromSources(), { adjacency: {}, files: [] });
  const graph = buildDependencyGraphFromSources({ 'main.js': "import './missing.js';", 'empty.js': null });
  assert.deepEqual(graph.adjacency, { 'main.js': [], 'empty.js': [] });
});
