const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const observerPath = "/workspace/scratch/4bed741d4966/worktrees/ecc-observer-git-context/scripts/lib/observer-sessions.js";
const localKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX'];
let passed = 0;
let failed = 0;

function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const name = process.platform === 'win32' ? key.toUpperCase() : key;
    return !localKeys.includes(name) && name !== 'CLAUDE_PROJECT_DIR';
  }));
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, env: cleanEnvironment(), encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function initRepo(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  git(directory, ['init']);
  git(directory, ['remote', 'add', 'origin', `https://example.invalid/${name}.git`]);
}

function hashId(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function test(name, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-observer-git-context-')));
  try {
    const target = path.join(root, 'target');
    const foreign = path.join(root, 'foreign');
    initRepo(target, 'target');
    initRepo(foreign, 'foreign');
    const fixture = { root, target, foreign, storage: path.join(root, 'store') };
    fn(fixture);
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error.stack}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function inheritedContext(directory) {
  return {
    GIT_DIR: path.join(directory, '.git'),
    GIT_WORK_TREE: directory,
    GIT_COMMON_DIR: path.join(directory, '.git'),
    GIT_INDEX_FILE: path.join(directory, '.git', 'index'),
    GIT_PREFIX: 'foreign-prefix/'
  };
}

function runContext(fixture, cwd, inherited = {}, explicitRoot, processCwd = cwd) {
  const env = { ...cleanEnvironment(), CLV2_HOMUNCULUS_DIR: fixture.storage, ...inherited };
  if (explicitRoot !== undefined) env.CLAUDE_PROJECT_DIR = explicitRoot;
  const script = `
    const assert = require('assert');
    const fs = require('fs');
    const observer = require(${JSON.stringify(observerPath)});
    const before = { ...process.env };
    const context = observer.resolveProjectContext(${JSON.stringify(cwd)});
    const lease = observer.writeSessionLease(context, 'fixture-session');
    assert.deepStrictEqual({ ...process.env }, before, 'resolution must not mutate the process environment');
    process.stdout.write(JSON.stringify({ context, lease, payload: JSON.parse(fs.readFileSync(lease, 'utf8')) }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: processCwd, env, encoding: 'utf8', timeout: 15000
  });
  assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function expectProject(fixture, result, root, projectId = hashId('example.invalid/target')) {
  assert.strictEqual(fs.realpathSync(result.context.projectRoot), fs.realpathSync(root));
  assert.strictEqual(result.context.projectId, projectId);
  assert.strictEqual(result.context.isGlobal, false);
  assert.strictEqual(result.lease,
    path.join(fixture.storage, 'projects', projectId, '.observer-sessions', 'fixture-session.json'));
  assert.strictEqual(result.payload.sessionId, 'fixture-session');
}

function subdirectory(root) {
  const child = path.join(root, 'src');
  fs.mkdirSync(child, { recursive: true });
  return child;
}

function externalMetadata(fixture, root = fixture.target, configureWorktree = true) {
  const metadata = path.join(fixture.root, 'external-metadata');
  fs.renameSync(path.join(root, '.git'), metadata);
  if (configureWorktree) git(fixture.root, ['--git-dir', metadata, 'config', 'core.worktree', root]);
  return metadata;
}


test('independent: all four relative Git path keys share the original cwd', fixture => {
  externalMetadata(fixture, fixture.target, false);
  const inherited = { GIT_DIR: 'external-metadata', GIT_COMMON_DIR: 'external-metadata',
    GIT_INDEX_FILE: 'external-metadata/custom-index', GIT_WORK_TREE: 'target' };
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target), inherited,
    undefined, fixture.root), fixture.target);
});

test('independent: relative common and index paths preserve a configured worktree', fixture => {
  externalMetadata(fixture);
  const inherited = { GIT_DIR: 'external-metadata', GIT_COMMON_DIR: 'external-metadata',
    GIT_INDEX_FILE: 'external-metadata/custom-index' };
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target), inherited,
    undefined, fixture.root), fixture.target);
});

test('independent: clean context preserves Git configuration environment', fixture => {
  const inherited = { ...inheritedContext(fixture.foreign), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://example.invalid/configured.git' };
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target), inherited),
    fixture.target, hashId('example.invalid/configured'));
});

test('independent: symlink spelling preserves the environment-only worktree', fixture => {
  const metadata = externalMetadata(fixture);
  const alias = path.join(fixture.root, 'target-link');
  fs.symlinkSync(fixture.target, alias, 'dir');
  expectProject(fixture, runContext(fixture, subdirectory(alias),
    { GIT_DIR: metadata, GIT_WORK_TREE: alias }), fixture.target);
});

console.log(JSON.stringify({ passed, failed }));
process.exitCode = failed > 0 ? 1 : 0;
