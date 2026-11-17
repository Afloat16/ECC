const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const observerPath = path.resolve(__dirname, '../../scripts/lib/observer-sessions.js');
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

console.log('\n=== observer Git context tests ===\n');

test('explicit project root ignores an inherited foreign repository', fixture => {
  expectProject(fixture, runContext(fixture, fixture.foreign,
    inheritedContext(fixture.foreign), fixture.target), fixture.target);
});

test('project discovery uses the requested checkout from a subdirectory', fixture => {
  const cwd = subdirectory(fixture.target);
  expectProject(fixture, runContext(fixture, cwd, inheritedContext(fixture.foreign)), fixture.target);
});

test('GIT_COMMON_DIR alone cannot replace the target origin', fixture => {
  expectProject(fixture, runContext(fixture, fixture.target,
    { GIT_COMMON_DIR: path.join(fixture.foreign, '.git') }, fixture.target), fixture.target);
});

test('registry selection keeps the target remote id over a newer stale alias', fixture => {
  const id = hashId('example.invalid/target');
  fs.mkdirSync(fixture.storage, { recursive: true });
  fs.writeFileSync(path.join(fixture.storage, 'projects.json'), JSON.stringify({
    target: { id, root: fixture.target, last_seen: '2026-01-01T00:00:00Z' },
    stale: { id: 'stale-project', root: fixture.target, last_seen: '2026-02-01T00:00:00Z' }
  }));
  const result = runContext(fixture, fixture.target, inheritedContext(fixture.foreign), fixture.target);
  expectProject(fixture, result, fixture.target);
  assert.deepStrictEqual(result.context.aliasProjectIds, ['stale-project']);
});

test('remote-free linked worktree keeps the main checkout identity', fixture => {
  git(fixture.target, ['remote', 'remove', 'origin']);
  git(fixture.target, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'fixture']);
  const linked = path.join(fixture.root, 'linked');
  git(fixture.target, ['worktree', 'add', '-b', 'linked-fixture', linked]);
  const mainRoot = git(fixture.target, ['worktree', 'list', '--porcelain'])
    .split(/\r?\n/).find(line => line.startsWith('worktree ')).slice(9);
  expectProject(fixture, runContext(fixture, linked, inheritedContext(fixture.foreign)), linked, hashId(mainRoot));
});

test('non-repository directory does not acquire a foreign explicit worktree', fixture => {
  const directory = path.join(fixture.root, 'plain');
  fs.mkdirSync(directory);
  const result = runContext(fixture, directory, inheritedContext(fixture.foreign));
  assert.strictEqual(result.context.projectId, 'global');
  assert.strictEqual(result.context.projectRoot, '');
  assert.strictEqual(result.context.isGlobal, true);
  assert.strictEqual(result.lease, path.join(fixture.storage, '.observer-sessions', 'fixture-session.json'));
});

test('ordinary checkout discovery is unchanged without Git-local variables', fixture => {
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target)), fixture.target);
});

test('matching Git-local context retains the same checkout identity', fixture => {
  expectProject(fixture, runContext(fixture, fixture.target, inheritedContext(fixture.target)), fixture.target);
});

test('nested checkout wins over the enclosing inherited worktree', fixture => {
  const nested = path.join(fixture.foreign, 'nested');
  initRepo(nested, 'target');
  expectProject(fixture, runContext(fixture, subdirectory(nested), inheritedContext(fixture.foreign)), nested);
});

test('foreign GIT_DIR alone cannot claim a subdirectory of an ordinary checkout', fixture => {
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target),
    { GIT_DIR: path.join(fixture.foreign, '.git') }), fixture.target);
});

test('relative foreign Git paths are interpreted from the original process directory', fixture => {
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target),
    { GIT_DIR: 'foreign/.git', GIT_WORK_TREE: 'foreign' }, undefined, fixture.root), fixture.target);
});

for (const explicit of [false, true]) {
  for (const workTreeVariable of [false, true]) {
    test(`environment-only worktree survives (explicit=${explicit}, workTree=${workTreeVariable})`, fixture => {
      const metadata = externalMetadata(fixture);
      const env = { GIT_DIR: metadata };
      if (workTreeVariable) env.GIT_WORK_TREE = fixture.target;
      expectProject(fixture, runContext(fixture, subdirectory(fixture.target), env,
        explicit ? fixture.target : undefined), fixture.target);
    });
  }
}

test('relative environment-only metadata and worktree survive a different requested cwd', fixture => {
  externalMetadata(fixture, fixture.target, false);
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target),
    { GIT_DIR: 'external-metadata', GIT_WORK_TREE: 'target' }, undefined, fixture.root), fixture.target);
});

test('relative GIT_DIR with core.worktree survives a different requested cwd', fixture => {
  externalMetadata(fixture);
  expectProject(fixture, runContext(fixture, subdirectory(fixture.target),
    { GIT_DIR: 'external-metadata' }, undefined, fixture.root), fixture.target);
});

for (const workTreeVariable of [false, true]) {
  test(`explicit environment-only worktree inside another checkout survives (workTree=${workTreeVariable})`, fixture => {
    const nested = path.join(fixture.foreign, 'environment-only');
    initRepo(nested, 'target');
    const metadata = externalMetadata(fixture, nested, !workTreeVariable);
    const env = { GIT_DIR: metadata };
    if (workTreeVariable) env.GIT_WORK_TREE = nested;
    expectProject(fixture, runContext(fixture, subdirectory(nested), env), nested);
  });
}

test('GIT_DIR-only worktree without another checkout retains its implicit cwd', fixture => {
  const plain = path.join(fixture.root, 'implicit-worktree');
  fs.mkdirSync(plain);
  expectProject(fixture, runContext(fixture, plain,
    { GIT_DIR: path.join(fixture.target, '.git') }), plain);
});

if (process.platform === 'win32') {
  for (const explicit of [false, true]) {
    test(`Windows ignores foreign Git keys regardless of spelling (explicit=${explicit})`, fixture => {
      const env = Object.fromEntries(Object.entries(inheritedContext(fixture.foreign))
        .map(([key, value]) => [key.toLowerCase(), value]));
      expectProject(fixture, runContext(fixture, subdirectory(fixture.target), env,
        explicit ? fixture.target : undefined), fixture.target);
    });
  }
}

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
