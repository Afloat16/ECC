'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildOrchestrationPlan } = require('../../scripts/lib/tmux-worktree-orchestrator');

const codeRoot = path.resolve(__dirname, '../..');
const orchestrator = path.join(codeRoot, 'scripts/orchestrate-worktrees.js');
const prefix = '.ecc-orchestration-task-';
const ignoreRule = '/' + prefix + '*/';

function run(program, args, cwd, env) {
  return spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 15000 });
}

function checked(program, args, cwd, env) {
  const result = run(program, args, cwd, env);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t, options = {}) {
  const { trackedIgnore, ...planOptions } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-worker-task-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo with 'quote");
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(path.join(codeRoot, 'scripts/orchestrate-codex-worker.sh'),
    path.join(repo, 'scripts/orchestrate-codex-worker.sh'));
  fs.writeFileSync(path.join(repo, 'README.md'), 'Original tracked content.\n');
  if (trackedIgnore !== undefined) fs.writeFileSync(path.join(repo, '.gitignore'), trackedIgnore);
  const captureScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cp = require('node:child_process');",
    'const args = process.argv.slice(2);',
    "const codex = args.includes('exec');",
    "const prompt = codex ? fs.readFileSync(0, 'utf8') : '';",
    "const task = codex ? prompt.match(/^Task file: (.+)$/m)[1] : args[0];",
    "const text = fs.readFileSync(task, 'utf8');",
    "fs.appendFileSync('README.md', 'Worker change.\\n');",
    "const git = values => cp.spawnSync('git', values, { encoding: 'utf8' });",
    "const ignored = git(['check-ignore', '--quiet', task]).status === 0;",
    "const added = git(['add', '--all']);",
    "if (added.status !== 0) throw new Error(added.stderr);",
    "const staged = git(['diff', '--cached', '--name-only']).stdout.trim().split('\\n');",
    "const capture = { args, prompt, task, text, ignored, staged, cwd: process.cwd(),",
    "  relative: path.relative(process.cwd(), fs.realpathSync(task)),",
    "  overlay: fs.existsSync('overlay.txt') ? fs.readFileSync('overlay.txt', 'utf8') : null };",
    "fs.writeFileSync(process.env.ECC_TEST_CAPTURE, JSON.stringify(capture));",
    "if (process.env.ECC_TEST_REPLACE_TASK === '1') {",
    '  fs.unlinkSync(task);',
    '  fs.symlinkSync(process.env.ECC_TEST_SENTINEL, task);',
    '}',
    'if (codex) {',
    "  fs.writeFileSync(args[args.indexOf('-o') + 1], 'Completed the fixture task.');",
    '}',
    'process.exit(Number(process.env.ECC_TEST_WORKER_EXIT || 0));'
  ].join('\n');
  fs.writeFileSync(path.join(repo, 'capture.cjs'), captureScript);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/usr/bin/env node\n' + captureScript, { mode: 0o755 });
  const tmuxScript = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const cp = require('node:child_process');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(process.env.ECC_TEST_TMUX_LOG, JSON.stringify(args) + '\\n');",
    "if (args[0] === 'has-session') process.exit(fs.existsSync(process.env.ECC_TEST_TMUX_STATE) ? 0 : 1);",
    "if (args[0] === 'new-session') fs.writeFileSync(process.env.ECC_TEST_TMUX_STATE, 'active');",
    "if (args[0] === 'kill-session') fs.rmSync(process.env.ECC_TEST_TMUX_STATE, { force: true });",
    "if (args[0] === 'split-window' && process.env.ECC_TEST_FAIL_SPLIT === '1') process.exit(7);",
    "if (args[0] === 'split-window') process.stdout.write('%1\\n');",
    "if (args[0] === 'send-keys' && args[2] === '%1') {",
    "  const result = cp.spawnSync('bash', ['-c', args[3]], { stdio: 'inherit' });",
    '  process.exit(result.status === null ? 1 : result.status);',
    '}'
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'tmux'), tmuxScript, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    ECC_TEST_CAPTURE: path.join(root, 'capture.json'), ECC_CODEX_APPROVAL_POLICY: 'never',
    ECC_TEST_TMUX_STATE: path.join(root, 'tmux-state'), ECC_TEST_TMUX_LOG: path.join(root, 'tmux-log'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[key];
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  checked('git', ['init', '-q'], repo, env);
  checked('git', ['add', '.'], repo, env);
  checked('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'], repo, env);
  const config = {
    repoRoot: repo, worktreeRoot: path.join(root, 'workers'), sessionName: 'task-root',
    launcherCommand: 'bash {repo_root_sh}/scripts/orchestrate-codex-worker.sh {task_file_sh} {handoff_file_sh} {status_file_sh}',
    workers: [{ name: 'one', task: 'Inspect README and preserve the current approval policy.' }],
    ...planOptions
  };
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(config));
  const plan = buildOrchestrationPlan(config);
  const exclude = path.join(repo, '.git', 'info', 'exclude');
  const originalExclude = Buffer.from('# Existing custom bytes\nkeep-this-rule');
  fs.writeFileSync(exclude, originalExclude);
  return { root, repo, env, config, plan, planPath, exclude, originalExclude };
}

function prepare(f) {
  checked(process.execPath, [orchestrator, f.planPath, '--write-only'], f.repo, f.env);
  for (const worker of f.plan.workerPlans) checked('git', worker.gitArgs, f.repo, f.env);
}

function launch(f, worker = f.plan.workerPlans[0], extraEnv = {}) {
  return run('bash', ['-c', worker.launchCommand], worker.worktreePath, { ...f.env, ...extraEnv });
}

function capture(f) {
  return JSON.parse(fs.readFileSync(f.env.ECC_TEST_CAPTURE, 'utf8'));
}

function assertLocalTask(data) {
  assert.equal(path.isAbsolute(data.relative), false);
  assert.equal(data.relative.startsWith('..'), false, 'Task must stay in its worker worktree');
  assert.equal(data.ignored, true, 'Generated task must not be added to Git');
  assert.deepEqual(data.staged, ['README.md']);
}

function assertCleanTaskDirectory(worker) {
  assert.deepEqual(fs.readdirSync(worker.worktreePath).filter(name => name.startsWith(prefix)), []);
}

test('write-only plans launch the real worker from a newly created Git worktree', t => {
  const f = fixture(t);
  prepare(f);
  const worker = f.plan.workerPlans[0];
  const originalTask = fs.readFileSync(worker.taskFilePath);
  const result = launch(f);
  assert.equal(result.status, 0, result.stderr);
  const data = capture(f);
  assertLocalTask(data);
  assert.ok(data.text.includes(f.config.workers[0].task));
  assert.equal(data.args[data.args.indexOf('--ask-for-approval') + 1], 'never');
  assert.deepEqual(fs.readFileSync(worker.taskFilePath), originalTask);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: completed'));
  assert.ok(fs.readFileSync(worker.handoffFilePath, 'utf8').includes('Completed the fixture task.'));
  assertCleanTaskDirectory(worker);
  const exclude = fs.readFileSync(f.exclude);
  assert.deepEqual(exclude.subarray(0, f.originalExclude.length), f.originalExclude);
  assert.ok(exclude.toString().split('\n').includes(ignoreRule));
  assert.equal(fs.existsSync(path.join(worker.worktreePath, '.gitignore')), false);
});

test('execute creates worktrees and applies overlays before launching the local task', t => {
  const f = fixture(t, { seedPaths: ['overlay.txt'] });
  fs.writeFileSync(path.join(f.repo, 'overlay.txt'), 'A selected local overlay.\n');
  const result = run(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
  assert.equal(result.status, 0, result.stderr);
  const data = capture(f);
  assert.equal(data.relative.startsWith('..'), false);
  assert.equal(data.ignored, true);
  assert.equal(data.overlay, 'A selected local overlay.\n');
  assert.deepEqual(data.staged, ['README.md', 'overlay.txt']);
  assertCleanTaskDirectory(f.plan.workerPlans[0]);
});

test('replaceExisting can run the same plan again after a completed worker', t => {
  const f = fixture(t, { replaceExisting: true });
  const worker = f.plan.workerPlans[0];
  checked(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
  const first = capture(f);
  assertLocalTask(first);
  assertCleanTaskDirectory(worker);
  const exclude = fs.readFileSync(f.exclude);
  checked(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
  const second = capture(f);
  assertLocalTask(second);
  assert.notEqual(first.task, second.task);
  assertCleanTaskDirectory(worker);
  assert.equal(fs.readFileSync(path.join(worker.worktreePath, 'README.md'), 'utf8'),
    'Original tracked content.\nWorker change.\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'README.md'), 'utf8'), 'Original tracked content.\n');
  assert.deepEqual(fs.readFileSync(f.exclude), exclude);
  const tmuxCalls = fs.readFileSync(f.env.ECC_TEST_TMUX_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(tmuxCalls.filter(args => args[0] === 'kill-session').length, 1);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: completed'));
});

test('failed pane creation rolls back real worktrees before any task is staged', t => {
  const f = fixture(t);
  const worker = f.plan.workerPlans[0];
  const result = run(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo,
    { ...f.env, ECC_TEST_FAIL_SPLIT: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.equal(fs.existsSync(f.env.ECC_TEST_TMUX_STATE), false);
  assert.equal(fs.existsSync(worker.worktreePath), false);
  assert.equal(fs.existsSync(f.plan.coordinationDir), false);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/' + worker.branchName], f.repo, f.env).status, 1);
  assert.deepEqual(fs.readFileSync(f.exclude), f.originalExclude);
});

test('an existing session prevents another launch without replacing its completed work', t => {
  const f = fixture(t);
  const worker = f.plan.workerPlans[0];
  checked(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
  const first = fs.readFileSync(f.env.ECC_TEST_CAPTURE);
  const status = fs.readFileSync(worker.statusFilePath);
  const result = run(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('tmux session already exists'));
  assert.deepEqual(fs.readFileSync(f.env.ECC_TEST_CAPTURE), first);
  assert.deepEqual(fs.readFileSync(worker.statusFilePath), status);
  assertCleanTaskDirectory(worker);
});

test('missing overlays roll back real worktrees before starting a staged task', t => {
  const f = fixture(t, { seedPaths: ['missing-overlay.txt'] });
  const worker = f.plan.workerPlans[0];
  const result = run(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('Seed path does not exist'));
  assert.equal(fs.existsSync(worker.worktreePath), false);
  assert.equal(fs.existsSync(f.plan.coordinationDir), false);
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.deepEqual(fs.readFileSync(f.exclude), f.originalExclude);
});

test('an unnamed worker can stage a task with only its own launcher override', t => {
  const f = fixture(t, {
    sessionName: undefined,
    launcherCommand: undefined,
    workers: [{ task: 'Worker-specific launcher task.',
      launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' }]
  });
  prepare(f);
  const result = launch(f);
  assert.equal(result.status, 0, result.stderr);
  const data = capture(f);
  assertLocalTask(data);
  assert.ok(data.text.includes('# Worker Task: worker-1'));
  assert.ok(data.text.includes('Worker-specific launcher task.'));
  assertCleanTaskDirectory(f.plan.workerPlans[0]);
});

test('invalid task plans and launcher templates still fail before materialization', t => {
  const f = fixture(t);
  const cases = [
    [{ launcherCommand: '  \t ' }, 'non-empty string'],
    [{ launcherCommand: 'echo {task_file_unknown}' }, 'Unknown template variable'],
    [{ launcherCommand: null }, 'missing a launcherCommand'],
    [{ workers: [{ name: 'one', task: '' }] }, 'missing a task'],
    [{ workers: null }, 'at least one worker']
  ];
  for (const [options, message] of cases) {
    fs.writeFileSync(f.planPath, JSON.stringify({ ...f.config, ...options }));
    const result = run(process.execPath, [orchestrator, f.planPath, '--execute'], f.repo, f.env);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(fs.existsSync(f.plan.coordinationDir), false);
    assert.equal(fs.existsSync(f.plan.workerPlans[0].worktreePath), false);
    assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  }
  assert.deepEqual(fs.readFileSync(f.exclude), f.originalExclude);
});

test('runtime rendering preserves raw and shell-safe task aliases for quoted paths', t => {
  const f = fixture(t, {
    launcherCommand: 'node {repo_root_sh}/capture.cjs "{task_file}" "{task_file_raw}" {task_file_sh}'
  });
  prepare(f);
  const result = launch(f);
  assert.equal(result.status, 0, result.stderr);
  const data = capture(f);
  assertLocalTask(data);
  assert.deepEqual(data.args, [data.task, data.task, data.task]);
  assertCleanTaskDirectory(f.plan.workerPlans[0]);
});

test('command failures retain their exit status and release the staged task', t => {
  const f = fixture(t, { launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' });
  prepare(f);
  const result = launch(f, undefined, { ECC_TEST_WORKER_EXIT: '23' });
  assert.equal(result.status, 23, result.stderr);
  assertLocalTask(capture(f));
  assertCleanTaskDirectory(f.plan.workerPlans[0]);
});

test('missing canonical tasks fail before the worker and leave a failed status', t => {
  const f = fixture(t);
  prepare(f);
  const worker = f.plan.workerPlans[0];
  fs.unlinkSync(worker.taskFilePath);
  const result = launch(f);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
  assertCleanTaskDirectory(worker);
});

test('cleanup never follows a replacement task symlink to a foreign file', t => {
  const f = fixture(t, { launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' });
  prepare(f);
  const sentinel = path.join(f.root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'Preserve this independent file.');
  const result = launch(f, undefined, { ECC_TEST_REPLACE_TASK: '1', ECC_TEST_SENTINEL: sentinel });
  assert.equal(result.status, 0, result.stderr);
  const data = capture(f);
  assertLocalTask(data);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'Preserve this independent file.');
  assert.equal(fs.lstatSync(data.task).isSymbolicLink(), true);
  assert.ok(fs.readFileSync(f.plan.workerPlans[0].taskFilePath, 'utf8').includes(f.config.workers[0].task));
});

test('direct worker calls still reject task files outside their worktree', t => {
  const f = fixture(t);
  prepare(f);
  const worker = f.plan.workerPlans[0];
  const result = run('bash', [path.join(f.repo, 'scripts/orchestrate-codex-worker.sh'),
    worker.taskFilePath, worker.handoffFilePath, worker.statusFilePath], worker.worktreePath, f.env);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('task file outside worktree'));
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
});

test('dry-run commands remain deterministic and do not precreate a worker directory', t => {
  const f = fixture(t);
  const first = checked(process.execPath, [orchestrator, f.planPath], f.repo, f.env);
  const second = checked(process.execPath, [orchestrator, f.planPath], f.repo, f.env);
  assert.equal(first, second);
  assert.equal(fs.existsSync(f.plan.workerPlans[0].worktreePath), false);
  assert.deepEqual(fs.readFileSync(f.exclude), f.originalExclude);
});

test('launchers without a task placeholder retain the original direct command', t => {
  const f = fixture(t, { launcherCommand: 'echo run' });
  assert.equal(f.plan.workerPlans[0].launchCommand, 'echo run');
  assert.deepEqual(fs.readFileSync(f.exclude), f.originalExclude);
});

test('repeated launches reuse the exclusion rule without rewriting existing bytes', t => {
  const f = fixture(t, { launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' });
  prepare(f);
  assert.equal(launch(f).status, 0);
  assertLocalTask(capture(f));
  const first = fs.readFileSync(f.exclude);
  assert.equal(launch(f).status, 0);
  assertLocalTask(capture(f));
  assert.deepEqual(fs.readFileSync(f.exclude), first);
  assertCleanTaskDirectory(f.plan.workerPlans[0]);
});

test('repositories without an info/exclude file still stage ignored local tasks', t => {
  const f = fixture(t);
  prepare(f);
  fs.unlinkSync(f.exclude);
  const result = launch(f);
  assert.equal(result.status, 0, result.stderr);
  assertLocalTask(capture(f));
  assert.ok(fs.readFileSync(f.exclude, 'utf8').split('\n').includes(ignoreRule));
  assertCleanTaskDirectory(f.plan.workerPlans[0]);
});

test('a missing worktree Git link stops preparation without launching the worker', t => {
  const f = fixture(t);
  prepare(f);
  const worker = f.plan.workerPlans[0];
  fs.unlinkSync(path.join(worker.worktreePath, '.git'));
  const result = launch(f);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('Cannot locate worktree Git exclusions'));
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assertCleanTaskDirectory(worker);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
});

test('an unavailable configured shell records failure and releases its staged task', t => {
  const f = fixture(t);
  prepare(f);
  const worker = f.plan.workerPlans[0];
  const result = launch(f, worker, { SHELL: path.join(f.root, 'missing-shell') });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('ENOENT'));
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assertCleanTaskDirectory(worker);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
});

test('a task source symlink is refused without copying its target into the worker', t => {
  const f = fixture(t, { launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' });
  prepare(f);
  const worker = f.plan.workerPlans[0];
  fs.unlinkSync(worker.taskFilePath);
  fs.symlinkSync(path.join(f.repo, 'README.md'), worker.taskFilePath);
  const result = launch(f);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
  assertCleanTaskDirectory(worker);
  assert.deepEqual(fs.readFileSync(f.exclude), f.originalExclude);
});

test('exclusion publication errors prevent the worker from seeing an unignored task', t => {
  const f = fixture(t, { launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' });
  prepare(f);
  const worker = f.plan.workerPlans[0];
  fs.unlinkSync(f.exclude);
  fs.mkdirSync(f.exclude);
  const result = launch(f);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
  assertCleanTaskDirectory(worker);
});

test('tracked ignore negations prevent launch instead of exposing a task to git add', t => {
  const trackedIgnore = '!/.ecc-orchestration-task-*/\n';
  const f = fixture(t, { trackedIgnore });
  prepare(f);
  const worker = f.plan.workerPlans[0];
  const original = fs.readFileSync(worker.taskFilePath);
  const result = launch(f);
  assert.notEqual(result.status, 0, 'A task visible to ordinary git add must not reach the worker');
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.ok(result.stderr.includes('not ignored'));
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
  assert.deepEqual(fs.readFileSync(worker.taskFilePath), original);
  assert.equal(fs.readFileSync(path.join(worker.worktreePath, '.gitignore'), 'utf8'), trackedIgnore);
  assertCleanTaskDirectory(worker);
  assert.equal(checked('git', ['status', '--porcelain'], worker.worktreePath, f.env), '');
});

test('copy errors remove only the empty staging directory and preserve the canonical task', t => {
  const f = fixture(t, { launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}' });
  prepare(f);
  const worker = f.plan.workerPlans[0];
  const original = fs.readFileSync(worker.taskFilePath);
  const preload = path.join(f.root, 'copy-error.cjs');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    'const original = fs.copyFileSync;',
    'fs.copyFileSync = (source, destination, flags) => {',
    "  if (destination.includes('.ecc-orchestration-task-')) throw Object.assign(new Error('fixture copy failed'), { code: 'EIO' });",
    '  return original(source, destination, flags);',
    '};'
  ].join('\n'));
  const result = launch(f, undefined, { NODE_OPTIONS: '--require=' + preload });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('fixture copy failed'));
  assert.equal(fs.existsSync(f.env.ECC_TEST_CAPTURE), false);
  assert.deepEqual(fs.readFileSync(worker.taskFilePath), original);
  assert.ok(fs.readFileSync(worker.statusFilePath, 'utf8').includes('- State: failed'));
  assertCleanTaskDirectory(worker);
});

test('parallel worker launches preserve common Git exclusions and independent tasks', async t => {
  const f = fixture(t, {
    launcherCommand: 'node {repo_root_sh}/capture.cjs {task_file_sh}',
    workers: [{ name: 'one', task: 'First independent task.' }, { name: 'two', task: 'Second independent task.' }]
  });
  prepare(f);
  const captures = await Promise.all(f.plan.workerPlans.map((worker, index) => new Promise((resolve, reject) => {
    const capturePath = path.join(f.root, 'parallel-' + index + '.json');
    const child = spawn('bash', ['-c', worker.launchCommand], {
      cwd: worker.worktreePath, env: { ...f.env, ECC_TEST_CAPTURE: capturePath }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(stderr || 'Worker failed'));
      else resolve(JSON.parse(fs.readFileSync(capturePath, 'utf8')));
    });
  })));
  captures.forEach((data, index) => {
    assertLocalTask(data);
    assert.ok(data.text.includes(f.config.workers[index].task));
    assertCleanTaskDirectory(f.plan.workerPlans[index]);
  });
  assert.notEqual(captures[0].task, captures[1].task);
  const exclude = fs.readFileSync(f.exclude);
  assert.deepEqual(exclude.subarray(0, f.originalExclude.length), f.originalExclude);
  assert.ok(exclude.toString().split('\n').includes(ignoreRule));
});
