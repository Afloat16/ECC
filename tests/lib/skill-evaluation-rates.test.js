'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createSkillObservation } = require('../../scripts/lib/skill-improvement/observations');
const { buildSkillEvaluationScaffold } = require('../../scripts/lib/skill-improvement/evaluate');

function runs(successes, count, variant, amendmentId = null, skillId = 'api-design') {
  return Array.from({ length: count }, (_, i) => createSkillObservation({
    task: 'Review API', skill: { id: skillId }, success: i < successes, variant, amendmentId,
  }));
}

function evaluate(baseline, amended, options = {}) {
  return buildSkillEvaluationScaffold('api-design', [
    ...runs(...baseline, 'baseline'), ...runs(...amended, 'amended'),
  ], options);
}

test('rounds a positive rate difference once, after subtracting raw rates', () => {
  const report = evaluate([1, 3], [2, 3]);
  assert.equal(report.baseline.successRate, 0.333);
  assert.equal(report.amended.successRate, 0.667);
  assert.equal(report.delta.successRate, 0.333);
  assert.equal(report.delta.failures, -1);
  assert.equal(report.recommendation, 'promote-amendment');
});

test('rounds a negative rate difference once', () => {
  const report = evaluate([2, 3], [1, 3]);
  assert.equal(report.delta.successRate, -0.333);
  assert.equal(report.delta.failures, 1);
  assert.equal(report.recommendation, 'keep-baseline');
});

test('a positive improvement smaller than display precision still improves the rate', () => {
  // 501/1001 is greater than 1/2, although both round to 0.500.
  const report = evaluate([1, 2], [501, 1001]);
  assert.equal(report.baseline.successRate, 0.5);
  assert.equal(report.amended.successRate, 0.5);
  assert.equal(report.delta.successRate, 0);
  assert.equal(report.recommendation, 'promote-amendment');
});

test('a negative improvement smaller than display precision keeps the baseline', () => {
  const report = evaluate([501, 1001], [1, 2]);
  assert.equal(Math.abs(report.delta.successRate), 0);
  assert.equal(report.recommendation, 'keep-baseline');
});

test('equal rates with different sample counts keep the baseline', () => {
  const report = evaluate([1, 3], [2, 6]);
  assert.equal(report.delta.successRate, 0);
  assert.equal(report.recommendation, 'keep-baseline');
});

test('sample-count gates still precede any improvement recommendation', () => {
  assert.equal(evaluate([0, 1], [2, 2]).recommendation, 'insufficient-data');
  const report = evaluate([1, 3], [2, 3], { minimumRunsPerVariant: 4 });
  assert.equal(report.gate.minimumRunsPerVariant, 4);
  assert.equal(report.recommendation, 'insufficient-data');
});

test('missing observations keep finite zero summaries and the existing gate', () => {
  for (const [baseline, amended] of [[[0, 0], [0, 0]], [[1, 2], [0, 0]], [[0, 0], [1, 2]]]) {
    const report = evaluate(baseline, amended);
    for (const value of [report.baseline.successRate, report.amended.successRate, report.delta.successRate]) {
      assert.equal(Number.isFinite(value), true);
    }
    assert.equal(report.recommendation, 'insufficient-data');
  }
});

test('filters skill and amendment runs without changing input observations', () => {
  const records = [
    ...runs(1, 3, 'baseline').map(record => ({ ...record, run: null })),
    ...runs(2, 3, 'amended', 'selected'),
    ...runs(0, 10, 'amended', 'other'),
    ...runs(0, 10, 'baseline', null, 'other-skill'),
  ];
  records.forEach(record => Object.freeze(record));
  Object.freeze(records);
  const before = JSON.stringify(records);
  const report = buildSkillEvaluationScaffold('api-design', records, { amendmentId: 'selected' });
  assert.equal(report.baseline.runs, 3);
  assert.equal(report.amended.runs, 3);
  assert.equal(report.delta.successRate, 0.333);
  assert.equal(report.recommendation, 'promote-amendment');
  assert.equal(JSON.stringify(records), before);
});

test('the evaluation CLI computes raw deltas and leaves its source log unchanged', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-evaluate-rates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.resolve(__dirname, '../../scripts/session-inspect.js');
  const log = path.join(root, 'observations.jsonl');
  for (const [baseline, amended, delta] of [[[1, 3], [2, 3], 0.333], [[1, 2], [501, 1001], 0]]) {
    const records = [...runs(...baseline, 'baseline'), ...runs(...amended, 'amended', 'selected')];
    const before = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(log, before);
    const result = spawnSync(process.execPath, [
      cli, 'skills:evaluate', '--skill', 'api-design', '--amendment-id', 'selected', '--observations', log,
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.delta.successRate, delta);
    assert.equal(report.recommendation, 'promote-amendment');
    assert.equal(fs.readFileSync(log, 'utf8'), before);
  }
});
