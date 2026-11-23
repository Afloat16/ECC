'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const cli = path.resolve(__dirname, '../../scripts/astra-review.js');

function fixture(t, format) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-astra-object-format-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const config = path.join(root, 'empty-git-config');
  fs.writeFileSync(config, '[maintenance]\n  auto = false\n[gc]\n  auto = 0\n');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config
  };
  const run = (command, args, options = {}) => spawnSync(command, args, {
    cwd: repo, env, encoding: 'utf8', ...options
  });
  const initialized = run('git', ['init', '-q', '--object-format=' + format]);
  if (format === 'sha256' && initialized.status !== 0
    && /unknown option|unknown hash algorithm|unsupported hash algorithm/.test(initialized.stderr)) {
    t.skip('The installed Git does not support SHA-256 repositories');
    return null;
  }
  assert.equal(initialized.status, 0, initialized.stderr);
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    'commit', '-qm', 'Root fixture');
  return { repo, env, run, git, commit };
}

function objectFiles(repo) {
  return fs.readdirSync(path.join(repo, '.git', 'objects'), { recursive: true }).sort();
}

function review(f, ...flags) {
  const before = objectFiles(f.repo);
  const result = f.run(process.execPath, [cli, '--dry-run', ...flags]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(objectFiles(f.repo), before, 'Scope collection must not write Git objects');
  return result.stdout;
}

function assertUsableRecovery(f, output, format) {
  const match = output.match(/(?:git diff(?: --cached)? |index vs |current pointer vs )([0-9a-f]+)\b/);
  assert.ok(match, 'The prompt must include a concrete baseline recovery command');
  assert.equal(match[1].length, format === 'sha256' ? 64 : 40);
  f.git('diff', match[1], '--', 'first.txt');
}

for (const format of ['sha1', 'sha256']) {
  test(format + ': review an unborn index together with working-tree and untracked changes', t => {
    const f = fixture(t, format);
    if (!f) return;
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'Staged first version.\n');
    f.git('add', 'first.txt');
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'Later working-tree version.\n');
    fs.writeFileSync(path.join(f.repo, 'new file.txt'), 'Untracked version.\n');
    const output = review(f);
    assert.ok(output.includes('+Staged first version.'));
    assert.ok(output.includes('+Later working-tree version.'));
    assert.ok(output.includes('+Untracked version.'));
    assertUsableRecovery(f, output, format);
  });

  test(format + ': an empty unborn repository reports nothing to review', t => {
    const f = fixture(t, format);
    if (!f) return;
    assert.equal(review(f), 'Nothing to review (uncommitted changes).\n');
  });

  test(format + ': root-commit repair keeps present content and usable recovery hints', t => {
    const f = fixture(t, format);
    if (!f) return;
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'Original content.\n');
    f.git('add', 'first.txt');
    f.commit();
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'Repaired content.\n' + 'x'.repeat(256 * 1024));
    const output = review(f, '--files-from-commit', 'HEAD');
    assert.ok(output.includes('=== first.txt ===\nRepaired content.'));
    assertUsableRecovery(f, output, format);
  });

  test(format + ': root-commit repair retains removed paths in the review', t => {
    const f = fixture(t, format);
    if (!f) return;
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'Added at root.\n');
    f.git('add', 'first.txt');
    f.commit();
    fs.unlinkSync(path.join(f.repo, 'first.txt'));
    const output = review(f, '--files-from-commit', 'HEAD');
    assert.ok(output.includes('=== first.txt === (absent now; added by commit'));
    assert.ok(output.includes('since removed, nothing left to diff'));
  });

  test(format + ': root-commit repair includes gitlink pointer changes', t => {
    const f = fixture(t, format);
    if (!f) return;
    const child = path.join(f.repo, 'child');
    fs.mkdirSync(child);
    f.git('-C', child, 'init', '-q', '--object-format=' + format);
    fs.writeFileSync(path.join(child, 'nested.txt'), 'Nested repository.\n');
    f.git('-C', child, 'add', 'nested.txt');
    f.git('-C', child, '-c', 'user.name=Test', '-c', 'user.email=test@example.test',
      'commit', '-qm', 'Nested root');
    f.git('add', 'child');
    f.commit();
    const output = review(f, '--files-from-commit', 'HEAD');
    assert.ok(output.includes('=== child === (directory or submodule; current pointer'));
    assert.ok(output.includes('new file mode 160000'));
    assert.ok(output.includes('Subproject commit ' + f.git('-C', child, 'rev-parse', 'HEAD')));
    assertUsableRecovery(f, output, format);
  });

  test(format + ': ordinary root-commit and subsequent-commit scopes remain usable', t => {
    const f = fixture(t, format);
    if (!f) return;
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'First commit.\n');
    f.git('add', 'first.txt');
    f.commit();
    assert.ok(review(f, '--commit', 'HEAD').includes('+First commit.'));
    fs.writeFileSync(path.join(f.repo, 'first.txt'), 'Second commit.\n');
    f.git('add', 'first.txt');
    f.commit();
    assert.ok(review(f, '--commit', 'HEAD').includes('+Second commit.'));
    assert.ok(review(f, '--base', 'HEAD~1').includes('+Second commit.'));
  });
}
