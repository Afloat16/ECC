'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyInstallPlan, createManifestInstallPlan } = require('../../scripts/lib/install-executor');

for (const target of ['hermes', 'claude']) {
  test(`commands-only ${target} installation includes the tracker lock dependency`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-tracker-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const homeDir = path.join(root, 'home');
    const projectRoot = path.join(root, 'project');
    fs.mkdirSync(homeDir);
    fs.mkdirSync(projectRoot);
    const plan = createManifestInstallPlan({
      sourceRoot: path.resolve(__dirname, '../..'), homeDir, projectRoot,
      target, moduleIds: ['commands-core'], env: {},
    });
    assert.deepEqual([...plan.selectedModuleIds].sort(), ['commands-core', 'shared-script-utils']);
    assert.equal(applyInstallPlan(plan).applied, true);
    const installedPath = relative => plan.operations.find(operation => operation.sourceRelativePath === relative).destinationPath;
    const script = installedPath('scripts/skills-health.js');
    const runsFilePath = path.join(root, 'runs.jsonl');
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    const report = () => {
      const result = spawnSync(process.execPath, [script,
        '--json', '--home', homeDir, '--runs-file', runsFilePath,
        '--skills-root', path.join(root, 'empty-skills'), '--now', '2026-11-11T12:00:00.000Z',
      ], { cwd: projectRoot, env, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(report().skills, []);

    const recorded = spawnSync(process.execPath, ['-e', `
      const tracker = require(process.argv[1]);
      const result = tracker.recordSkillExecution({
        skill_id: 'installed-skill', skill_version: '1', task_description: 'Skill invocation',
        outcome: 'success', recorded_at: '2026-11-11T12:00:00.000Z'
      }, { runsFilePath: process.argv[2] });
      process.stdout.write(result.storage);
    `, installedPath('scripts/lib/skill-evolution/tracker.js'), runsFilePath], {
      cwd: projectRoot, env, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    assert.equal(recorded.stdout, 'jsonl');
    assert.equal(fs.existsSync(`${runsFilePath}.ecc-state.lock`), false);
    const skills = report().skills;
    assert.equal(skills.length, 1);
    assert.equal(skills[0].skill_id, 'installed-skill');
    assert.equal(skills[0].run_count_30d, 1);
    assert.equal(skills[0].success_rate_30d, 1);
  });
}
