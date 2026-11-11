'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyInstallPlan, createManifestInstallPlan } = require('../../scripts/lib/install-executor');
const { repairInstalledStates } = require('../../scripts/lib/install-lifecycle');

function write(root, relative, content) {
  const filename = path.join(root, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

for (const [label, opening, inner, closing, newline] of [
  ['shorter backticks', '````markdown', '```', '````', '\n'],
  ['mixed fence characters', '```markdown', '~~~', '```', '\n'],
  ['shorter tildes and longer closing fence', '~~~~~markdown', '~~~', '~~~~~~', '\n'],
  ['info string is not a closing fence', '```markdown', '```example', '```', '\r\n'],
]) {
  test(`install and repair preserve examples within ${label}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-install-fences-'));
    const sourceRoot = path.join(root, 'source');
    const homeDir = path.join(root, 'home');
    const sourceLink = '../../rules/common/testing.md';
    const code = [opening, inner, `[example](${sourceLink})`, inner, closing].join(newline);
    const prose = `[reference](${sourceLink})${newline}`;
    const content = `${code}${newline}${prose}`;
    const expected = `${code}${newline}${prose.replace('/rules/', '/rules/ecc/')}`;
    try {
      write(sourceRoot, 'package.json', JSON.stringify({ name: 'ecc-universal', version: '1.0.0' }));
      write(sourceRoot, 'manifests/install-modules.json', JSON.stringify({ version: 1, modules: [{
        id: 'fixture', kind: 'fixture', description: 'Link rewrite fixture', paths: ['rules', 'skills'],
        targets: ['claude'], dependencies: [], defaultInstall: true, cost: 'light', stability: 'stable',
      }] }));
      write(sourceRoot, 'manifests/install-profiles.json', JSON.stringify({ version: 1,
        profiles: { minimal: { description: 'Link rewrite fixture', modules: ['fixture'] } } }));
      write(sourceRoot, 'rules/common/testing.md', '# Testing\n');
      write(sourceRoot, 'skills/example/SKILL.md', content);

      const plan = createManifestInstallPlan({ sourceRoot, homeDir, target: 'claude', profileId: 'minimal' });
      const applied = applyInstallPlan(plan);
      assert.equal(applied.applied, true);
      const installedSkill = path.join(homeDir, '.claude', 'skills', 'example', 'SKILL.md');
      assert.equal(fs.readFileSync(installedSkill, 'utf8'), expected);
      assert.equal(fs.readFileSync(path.join(homeDir, '.claude', 'rules', 'ecc', 'common', 'testing.md'), 'utf8'), '# Testing\n');

      fs.unlinkSync(installedSkill);
      const repaired = repairInstalledStates({ repoRoot: sourceRoot, homeDir, projectRoot: root, targets: ['claude'] });
      assert.equal(repaired.results[0].error, null);
      assert.ok(repaired.results[0].repairedPaths.includes(installedSkill));
      assert.equal(fs.readFileSync(installedSkill, 'utf8'), expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
