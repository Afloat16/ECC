'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { recordSkillExecution } = require('../../scripts/lib/skill-evolution/tracker');

const script = path.join(__dirname, '../../scripts/skills-health.js');
const now = '2026-11-11T12:00:00.000Z';

function prepareRuns(t, recentSuccesses, olderSuccesses) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-dashboard-threshold-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills');
  const runsFilePath = path.join(root, 'runs.jsonl');
  for (const id of ['drifting', 'unchanged', 'unmeasured']) {
    const skillDir = path.join(skillsRoot, id);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${id}\n`);
  }
  for (const [recorded_at, successes] of [
    ['2026-11-10T12:00:00.000Z', recentSuccesses],
    ['2026-10-25T12:00:00.000Z', olderSuccesses],
  ]) {
    for (let index = 0; index < 10; index += 1) {
      recordSkillExecution({
        skill_id: 'drifting', skill_version: '1', task_description: 'Recorded skill run',
        outcome: index < successes ? 'success' : 'failure', recorded_at,
      }, { runsFilePath });
    }
    recordSkillExecution({
      skill_id: 'unchanged', skill_version: '1', task_description: 'Recorded skill run',
      outcome: 'success', recorded_at,
    }, { runsFilePath });
  }
  return [
    '--skills-root', skillsRoot, '--home', root, '--runs-file', runsFilePath, '--now', now,
  ];
}

function runCli(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const cases = [
  { name: 'sensitive declining threshold', recent: 5, older: 6, threshold: '0.05', trend: 'worsening', arrow: '\u2198' },
  { name: 'less sensitive threshold', recent: 5, older: 8, threshold: '0.2', trend: 'stable', arrow: '\u2192' },
  { name: 'zero threshold with a decline', recent: 5, older: 6, threshold: '0', trend: 'worsening', arrow: '\u2198' },
  { name: 'zero threshold with equal rates', recent: 5, older: 5, threshold: '0', trend: 'stable', arrow: '\u2192' },
  { name: 'sensitive improving threshold', recent: 6, older: 5, threshold: '0.05', trend: 'improving', arrow: '\u2197' },
  { name: 'default threshold at its rounded boundary', recent: 6, older: 8, trend: 'worsening', arrow: '\u2198' },
];

for (const fixture of cases) {
  test(`CLI health and dashboard agree at ${fixture.name}`, t => {
    const args = prepareRuns(t, fixture.recent, fixture.older);
    if (fixture.threshold !== undefined) args.push('--warn-threshold', fixture.threshold);
    const report = JSON.parse(runCli([...args, '--json']));
    const dashboard = JSON.parse(runCli([...args, '--dashboard', '--json']));
    const text = runCli([...args, '--panel', 'success-rate']);
    const skill = report.skills.find(entry => entry.skill_id === 'drifting');
    const chart = dashboard.panels['success-rate'].skills.find(entry => entry.skill_id === 'drifting');

    assert.equal(report.warn_threshold, Number(fixture.threshold ?? 0.1));
    assert.equal(skill.failure_trend, fixture.trend);
    assert.equal(dashboard.summary.declining_skills, fixture.trend === 'worsening' ? 1 : 0);
    assert.equal(chart.trend, fixture.arrow);
    assert.ok(text.split('\n').find(line => line.includes('drifting')).includes(fixture.arrow));

    for (const id of ['unchanged', 'unmeasured']) {
      assert.equal(report.skills.find(entry => entry.skill_id === id).failure_trend, 'stable');
      assert.equal(dashboard.panels['success-rate'].skills.find(entry => entry.skill_id === id).trend, '\u2192');
    }
  });
}
