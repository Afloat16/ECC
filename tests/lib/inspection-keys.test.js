'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { groupFailures, detectPatterns, generateReport, inspect } = require('../../scripts/lib/inspection');
const { createStateStore } = require('../../scripts/lib/state-store');

function run(id, skillId, failureReason, overrides = {}) {
  return {
    id, skillId, failureReason, outcome: 'failure', skillVersion: '1.0.0',
    sessionId: `session-${id}`, taskDescription: 'Validate failure grouping',
    tokensUsed: null, durationMs: null, userFeedback: null,
    createdAt: '2026-03-15T08:00:00.000Z', ...overrides,
  };
}

test('separates skill and reason tuples containing the old delimiter', () => {
  const first = run('one', 'lint::parser', 'timeout');
  const second = run('two', 'lint', 'parser::timeout');
  const groups = [...groupFailures([first, second]).values()];
  assert.deepEqual(groups, [
    { skillId: 'lint::parser', normalizedReason: 'timeout', runs: [first] },
    { skillId: 'lint', normalizedReason: 'parser::timeout', runs: [second] },
  ]);
});

test('does not combine independent counts into a false recurring pattern', () => {
  const runs = [
    run('one', 'lint::parser', 'timeout'),
    run('two', 'lint::parser', 'timeout'),
    run('three', 'lint', 'parser::timeout'),
  ];
  const report = generateReport(detectPatterns(runs));
  assert.equal(report.status, 'clean');
  assert.equal(report.patternCount, 0);
});

test('preserves attribution, timestamps and sorting when both groups meet the threshold', () => {
  const a = [1, 2].map(number => run(`a${number}`, 'lint::parser', 'timeout', {
    skillVersion: '1.0.0', sessionId: 'session-a', createdAt: `2026-03-15T08:0${number}:00.000Z`,
  }));
  const b = [1, 2, 3].map(number => run(`b${number}`, 'lint', 'parser::timeout', {
    skillVersion: '2.0.0', sessionId: 'session-b', createdAt: `2026-03-15T09:0${number}:00.000Z`,
  }));
  const patterns = detectPatterns([...a, ...b], { threshold: 2 });
  assert.equal(patterns.length, 2);
  assert.deepEqual(patterns.map(item => ({
    skill: item.skillId, count: item.count, sessions: item.sessionIds, versions: item.versions,
    reasons: item.rawReasons, ids: item.runIds, first: item.firstSeen, last: item.lastSeen,
  })), [
    { skill: 'lint', count: 3, sessions: ['session-b'], versions: ['2.0.0'], reasons: ['parser::timeout'],
      ids: ['b3', 'b2', 'b1'], first: b[0].createdAt, last: b[2].createdAt },
    { skill: 'lint::parser', count: 2, sessions: ['session-a'], versions: ['1.0.0'], reasons: ['timeout'],
      ids: ['a2', 'a1'], first: a[0].createdAt, last: a[1].createdAt },
  ]);
  const report = generateReport(patterns);
  assert.equal(report.totalFailures, 5);
  assert.deepEqual(report.affectedSkills, ['lint', 'lint::parser']);
});

test('keeps repeated separators and JSON punctuation unambiguous', () => {
  const tuples = [
    ['lint:', ':timeout'], ['lint', '::timeout'], ['lint::', 'timeout'],
    ['lint::"parser"', 'timeout'], ['lint', '"parser"::timeout'],
    ['lint,[parser]', 'timeout'], ['lint', '[parser],timeout'],
  ];
  const runs = tuples.map(([skillId, reason], index) => run(`row-${index}`, skillId, reason));
  const groups = [...groupFailures(runs).values()];
  assert.equal(groups.length, tuples.length);
  assert.deepEqual(groups.map(group => [group.skillId, group.normalizedReason]), tuples);
});

test('still normalizes repeated reasons and ignores successful runs', () => {
  const runs = [
    run('one', 'lint::parser', ' Timeout at 2026-03-15T08:00:00Z '),
    run('two', 'lint::parser', 'timeout at 2026-03-16T08:00:00Z', { outcome: 'ERROR' }),
    run('ok', 'lint::parser', 'timeout at 2026-03-17T08:00:00Z', { outcome: 'success' }),
    run('other', 'different', 'timeout at 2026-03-16T08:00:00Z'),
  ];
  const patterns = detectPatterns(Object.freeze(runs.map(Object.freeze)), { threshold: 2 });
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].skillId, 'lint::parser');
  assert.equal(patterns[0].normalizedReason, 'timeout at <timestamp>');
  assert.deepEqual(patterns[0].runIds, ['one', 'two']);
});

test('the inspection API keeps persisted state-store skill histories separate', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ecc-inspection-keys-'));
  const dbPath = path.join(root, 'state.db');
  let store;
  try {
    store = await createStateStore({ dbPath });
    const runs = [
      run('a1', 'lint::parser', 'timeout'), run('a2', 'lint::parser', 'timeout'),
      run('b1', 'lint', 'parser::timeout'), run('b2', 'lint', 'parser::timeout'),
    ];
    for (const entry of runs) {
      store.upsertSession({ id: entry.sessionId, adapterId: 'claude-history', harness: 'claude',
        state: 'completed', repoRoot: root, startedAt: entry.createdAt, endedAt: entry.createdAt, snapshot: {} });
      store.insertSkillRun(entry);
    }
    store.close();
    store = await createStateStore({ dbPath });
    const bytes = fs.readFileSync(dbPath);

    assert.equal(inspect(store, { threshold: 3 }).status, 'clean');
    const report = inspect(store, { threshold: 2 });
    assert.equal(report.patternCount, 2);
    assert.deepEqual(report.patterns.map(pattern => pattern.count), [2, 2]);
    assert.deepEqual(new Set(report.affectedSkills), new Set(['lint::parser', 'lint']));
    assert.deepEqual(fs.readFileSync(dbPath), bytes);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
