'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { withFixture, write, update } = require('./helpers/context-fixture');
const { loadContextRegistry } = require('../../scripts/lib/context-pack-registry');
const { buildRetrievalIndex, searchRetrieval } = require('../../scripts/lib/context-retrieval');
const { resolveTaskContext } = require('../../scripts/lib/context-selection');
const { compileContextProfile } = require('../../scripts/lib/context-profiles');
const { digestObject } = require('../../scripts/lib/context-profile-support');

const query = 'streaming transport frames';

function addSkills(root, policies, available = 1) {
  const names = [];
  for (const [index, policy] of policies.entries()) {
    const name = `streaming-transport-frames-${String(index).padStart(2, '0')}`;
    names.push(name);
    const metadata = policy === 'manual' ? 'disable-model-invocation: true\n'
      : policy === 'authority' ? 'allowed-tools: Bash\n' : '';
    const body = policy === 'large' ? 'Content. '.repeat(4000)
      : policy === 'dynamic' ? 'Inspect !`echo dynamic`.' : 'Instructions.';
    write(root, `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Streaming transport frames.\n${metadata}---\n${body}\n`);
    if (policy === 'codex-manual') {
      write(root, `skills/${name}/agents/openai.yaml`, 'policy:\n  allow_implicit_invocation: false\n');
    }
  }
  const allowedIds = Array.from({ length: available }, (_, index) => {
    const name = `fallback-${index}`;
    names.push(name);
    write(root, `skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: Streaming transport frames with a verified fallback.\n---\nUsable instructions ${index}.\n`);
    return `skill:${name}`;
  });
  update(root, 'manifests/install-modules.json', value => ({ ...value,
    modules: value.modules.map(module => ({ ...module, paths: [...module.paths, ...names.map(name => `skills/${name}`)] })),
  }));
  return allowedIds;
}

function ranked(root) {
  const registry = loadContextRegistry({ repoRoot: root });
  const index = buildRetrievalIndex(registry.entries);
  return searchRetrieval(index, query, { limit: index.entryCount });
}

function resolve(root, task = {}, options = {}) {
  return resolveTaskContext({ repoRoot: root, selectionMode: 'suggest', ...options,
    task: { sessionId: 'session-1', taskId: 'task-1', revision: 1, phase: 'implement', query, ...task },
  });
}

for (const policy of ['manual', 'codex-manual', 'authority', 'dynamic', 'large']) {
  test(`eligible skills remain discoverable after 16 ${policy} candidates`, () => withFixture(root => {
    const allowedIds = addSkills(root, Array(16).fill(policy));
    const all = ranked(root);
    assert.ok(all.findIndex(candidate => candidate.id === allowedIds[0]) >= 16,
      'the fixture must place the admissible skill beyond the old search window');
    const result = resolve(root);
    assert.deepEqual(result.candidates.map(candidate => candidate.id), allowedIds);
    assert.equal(result.reason, 'agent-selection-required');
    assert.deepEqual(result.loadedIds, []);
    const proposed = resolve(root, { proposedIds: allowedIds }, { selectionMode: 'auto', load: true });
    assert.deepEqual(proposed.loadedIds, allowedIds);
    assert.match(proposed.resources[0].content, /Usable instructions/);
  }));
}

test('filtering preserves retrieval order and the five-candidate public limit', () => withFixture(root => {
  const policies = Array.from({ length: 20 }, (_, index) => ['manual', 'authority', 'codex-manual', 'large'][index % 4]);
  const allowedIds = addSkills(root, policies, 7);
  const expected = ranked(root).filter(candidate => allowedIds.includes(candidate.id)).slice(0, 5);
  assert.equal(expected.length, 5);
  assert.deepEqual(resolve(root).candidates, expected);
}));

test('all denied candidates still produce an empty selection', () => withFixture(root => {
  addSkills(root, Array(20).fill('manual'), 0);
  const result = resolve(root);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.selectedIds, []);
  assert.equal(result.reason, 'no-selection');
}));

test('manual-only skills still require an explicit request before loading', () => withFixture(root => {
  addSkills(root, Array(16).fill('manual'));
  const id = 'skill:streaming-transport-frames-00';
  assert.throws(() => resolve(root, { proposedIds: [id] }, { selectionMode: 'auto', load: true }), /manual-only/);
  const result = resolve(root, { explicitIds: [id] }, { selectionMode: 'auto', load: true });
  assert.deepEqual(result.loadedIds, [id]);
}));

test('admission stops reading candidate policies once five skills have qualified', context => withFixture(root => {
  addSkills(root, [], 7);
  const lastPath = path.join(fs.realpathSync(root), 'skills/fallback-6/SKILL.md');
  const originalOpen = fs.openSync;
  let opens = 0;
  context.mock.method(fs, 'openSync', (filename, ...args) => {
    if (filename === lastPath) opens++;
    return originalOpen(filename, ...args);
  });
  try {
    assert.equal(resolve(root).candidates.length, 5);
    assert.equal(opens, 1, 'the final source is hashed for the registry but needs no admission read');
  } finally { context.mock.restoreAll(); }
}));

test('a cached empty selection from the old search window is reconsidered', () => withFixture(root => {
  const allowedIds = addSkills(root, Array(16).fill('manual'));
  const first = resolve(root, {}, { selectionMode: 'auto' });
  const plan = compileContextProfile({ repoRoot: root, selectionMode: 'auto' });
  const bindingDigest = digestObject({ sessionId: 'session-1', taskId: 'task-1', revision: 1,
    phase: 'implement', planDigest: plan.planDigest, routingPolicyVersion: 12,
    triggersDigest: digestObject({}), queryDigest: digestObject(query) });
  const { receiptDigest: _receiptDigest, ...receipt } = first.receipt;
  const oldReceipt = { ...receipt, bindingDigest, decision: 'none', selectedIds: [], explicitIds: [],
    loadedIds: [], resources: [], noWorkflow: false,
    selectionDigest: digestObject({ bindingDigest, selectedIds: [], explicitIds: [], noWorkflow: false }) };
  const previous = { ...oldReceipt, receiptDigest: digestObject(oldReceipt) };
  const result = resolve(root, {}, { selectionMode: 'auto', previous });
  assert.equal(result.reused, false);
  assert.deepEqual(result.candidates.map(candidate => candidate.id), allowedIds);
  assert.equal(result.reason, 'agent-selection-required');
}));
