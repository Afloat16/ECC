'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadContextRegistry } = require('../../scripts/lib/context-pack-registry');
const { buildRetrievalIndex, searchRetrieval, sparseDense } = require('../../scripts/lib/context-retrieval');
const { resolveTaskContext } = require('../../scripts/lib/context-selection');

const entry = name => ({ id: `skill:${name}`, name, description: `Guidance for ${name}.` });
const exactIds = results => results.filter(result => result.exact).map(result => result.id).sort();
const featureEntries = name => [entry('feature'), { ...entry(name),
  description: 'Instructions covering planning, verification and reporting. '.repeat(20) }];

for (const longerName of ['feature-v2', 'new-feature', 'new-feature-guide']) {
  test(`the complete ${longerName} citation ranks before its contained name`, () => {
    const index = buildRetrievalIndex(featureEntries(longerName));
    const results = searchRetrieval(index, `Use ${longerName}.`);
    assert.equal(results[0].id, `skill:${longerName}`);
    assert.deepEqual(exactIds(results), ['skill:feature', `skill:${longerName}`].sort());
  });
}

for (const query of [
  'Use feature and feature-v2.',
  'Use feature-v2, then feature.',
  'feature-v2 feature feature-v2',
]) {
  test(`an independently mentioned shorter name keeps its original rank: ${query}`, () => {
    const results = searchRetrieval(buildRetrievalIndex(featureEntries('feature-v2')), query);
    assert.equal(results[0].id, 'skill:feature');
    assert.deepEqual(exactIds(results), ['skill:feature', 'skill:feature-v2']);
  });
}

for (const query of ['“feature-v2”', '`feature_v2`', '(feature–v2)', '使用 feature-v2 技能']) {
  test(`normalization preserves complete-name priority: ${query}`, () => {
    const results = searchRetrieval(buildRetrievalIndex([entry('feature'), entry('feature-v2')]), query);
    assert.equal(results[0].id, 'skill:feature-v2');
    assert.deepEqual(exactIds(results), ['skill:feature', 'skill:feature-v2']);
  });
}

test('equal native names on different entries retain both exact identities', () => {
  const entries = ['first', 'second'].map(id => ({ ...entry(id), name: 'shared-name' }));
  assert.deepEqual(exactIds(searchRetrieval(buildRetrievalIndex(entries), 'Use shared-name.')),
    ['skill:first', 'skill:second']);
});

test('a complete native alias receives the same priority as a canonical name', () => {
  const index = buildRetrievalIndex([
    { ...entry('first'), name: 'review' },
    { ...entry('second'), name: 'security-review' },
  ]);
  const results = searchRetrieval(index, 'Use securityReview.');
  assert.equal(results[0].id, 'skill:second');
  assert.deepEqual(exactIds(results), ['skill:first', 'skill:second']);
});

test('a near-match suffix does not create an exact match for the longer skill', () => {
  const index = buildRetrievalIndex([entry('feature'), entry('feature-v2')]);
  assert.deepEqual(exactIds(searchRetrieval(index, 'feature-v20 and feature')), ['skill:feature']);
});

test('overlapping repeated full names cover each shorter-name occurrence', () => {
  const results = searchRetrieval(buildRetrievalIndex(featureEntries('feature-feature')), 'feature feature feature');
  assert.equal(results[0].id, 'skill:feature-feature');
  assert.deepEqual(exactIds(results), ['skill:feature', 'skill:feature-feature']);
});

test('every canonical name in the actual registry ranks its own skill first', () => {
  const { entries } = loadContextRegistry();
  const computed = buildRetrievalIndex(entries);
  const stored = buildRetrievalIndex(entries.map(value => ({ ...value, dense: sparseDense(value) })));
  for (const value of entries) {
    const query = value.id.slice('skill:'.length);
    const results = searchRetrieval(computed, query);
    assert.equal(results[0]?.id, value.id, query);
    assert.deepEqual(searchRetrieval(stored, query), results, query);
  }
});

for (const name of ['continuous-learning-v2', 'benchmark-optimization-loop']) {
  test(`the resolver keeps its existing ambiguity guard for ${name}`, () => {
    const result = resolveTaskContext({
      task: { sessionId: 'overlap-session', taskId: 'overlap-task', revision: 1,
        phase: 'implement', query: `Use the ${name} skill.` },
      selectionMode: 'auto',
      load: true,
    });
    assert.equal(result.candidates[0].id, `skill:${name}`);
    assert.equal(result.reason, 'agent-selection-required');
    assert.deepEqual(result.selectedIds, []);
    assert.deepEqual(result.loadedIds, []);
    assert.deepEqual(result.resources, []);
  });
}
