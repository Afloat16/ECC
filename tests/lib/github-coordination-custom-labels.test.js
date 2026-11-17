'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const coordination = require('../../scripts/lib/github-coordination');

function fixture(t, initial, custom = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-custom-labels-'));
  const config = path.join(root, 'policy.json');
  const labels = Object.fromEntries(Object.keys(coordination.DEFAULT_POLICY.labels)
    .map(key => [key, `workflow:${key}`]));
  fs.writeFileSync(config, JSON.stringify({ labels: custom ? labels : {} }));
  const policy = coordination.loadPolicy(root, config);
  const state = {
    status: 'available', validation: 'pending', review: 'not-requested',
    dependencies: [], tasks: [], ...initial,
  };
  const issue = {
    number: 7, title: 'An isolated coordination fixture', state: 'OPEN',
    author: { login: 'fixture-owner' },
    labels: [...Object.values(policy.labels), 'team:manual', 'workflow:unmanaged', 'coordination:obsolete'],
    body: '## Tasks\n- [ ] Complete work\n\n' + coordination.renderCoordinationState(state, policy),
  };
  const statePath = path.join(root, 'issue.json');
  const callsPath = path.join(root, 'calls.jsonl');
  const shimPath = path.join(root, 'gh-shim.js');
  fs.writeFileSync(statePath, JSON.stringify(issue));
  fs.writeFileSync(shimPath, `
const fs = require('node:fs');
const file = ${JSON.stringify(statePath)};
const calls = ${JSON.stringify(callsPath)};
const args = process.argv.slice(2);
fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
const issue = JSON.parse(fs.readFileSync(file, 'utf8'));
if (args[0] !== 'issue') throw new Error('Unexpected fixture command');
if (args[1] === 'view') process.stdout.write(JSON.stringify(issue));
else if (args[1] === 'list') process.stdout.write(JSON.stringify([issue]));
else if (args[1] === 'comment') process.stdout.write('{}');
else if (args[1] === 'edit') {
  for (let index = 2; index < args.length; index++) {
    if (args[index] === '--body') issue.body = args[++index];
    else if (args[index] === '--add-label') issue.labels = [...new Set([...issue.labels, args[++index]])];
    else if (args[index] === '--remove-label') {
      const label = args[++index]; issue.labels = issue.labels.filter(item => item !== label);
    }
  }
  fs.writeFileSync(file, JSON.stringify(issue));
  process.stdout.write('{}');
} else throw new Error('Unexpected fixture command');
`);
  const previous = process.env.ECC_GH_SHIM;
  process.env.ECC_GH_SHIM = shimPath;
  t.after(() => {
    if (previous === undefined) delete process.env.ECC_GH_SHIM;
    else process.env.ECC_GH_SHIM = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    issue, policy, root, config,
    read: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    calls: () => fs.existsSync(callsPath)
      ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
  };
}

const cases = [
  ['claim', {}, ['claimed'], (options, context) => coordination.applyClaim('fixture/repo', 7, options, context)],
  ['sync', { status: 'ready', validation: 'passed', review: 'approved' },
    ['ready', 'validated', 'reviewApproved'], (options, context) => coordination.applySync('fixture/repo', options, context)],
  ['validate', { status: 'claimed', review: 'requested' },
    ['validated', 'reviewRequested'], (options, context) => coordination.applyValidate('fixture/repo', 7, options, context)],
  ['publish', { status: 'ready', review: 'approved' },
    ['published', 'validated', 'reviewApproved'], (options, context) => coordination.applyPublish('fixture/repo', 7, options, context)],
  ['review', { status: 'claimed', review: 'requested' },
    ['ready', 'reviewApproved'], (options, context) => coordination.applyReview('fixture/repo', 7, options, context)],
  ['decompose', {}, ['claimed'], (options, context) => coordination.applyDecompose('fixture/repo', 7, options, context)],
  ['unblock', { status: 'blocked', validation: 'failed' },
    ['ready'], (options, context) => coordination.applyUnblock('fixture/repo', options, context)],
];

for (const [name, initial, expectedKeys, invoke] of cases) {
  test(`${name} replaces stale configured labels while retaining unmanaged labels`, t => {
    const f = fixture(t, initial);
    invoke({ configPath: f.config });
    const expected = ['epic', 'synced', ...expectedKeys].map(key => f.policy.labels[key]);
    assert.deepEqual(f.read().labels.sort(), [...expected, 'team:manual', 'workflow:unmanaged'].sort());
    assert.ok(f.calls().some(args => args[1] === 'edit' && args.includes('--remove-label')));
  });
  if (name !== 'sync') {
    test(`${name} dry-run leaves issue labels and its audit trail untouched`, t => {
      const f = fixture(t, initial);
      const before = f.read();
      invoke({ dryRun: true }, { policy: f.policy });
      assert.deepEqual(f.read(), before);
      assert.ok(f.calls().every(args => ['view', 'list'].includes(args[1])));
    });
  }
}

test('dry-run reports custom removals without editing or commenting', t => {
  const f = fixture(t, { status: 'ready' });
  const before = f.read();
  const result = coordination.applySync('fixture/repo', { dryRun: true }, { policy: f.policy });
  assert.ok(result.items[0].labelPlan.removeLabels.includes(f.policy.labels.claimed));
  assert.deepEqual(f.read(), before);
  assert.ok(f.calls().every(args => args[1] === 'list'));
});

test('failed dependency validation removes a previous custom validated label', t => {
  const f = fixture(t, { status: 'blocked', validation: 'passed', dependencies: [7] });
  const result = coordination.applyValidate('fixture/repo', 7, {}, { policy: f.policy });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingDependencies, [7]);
  assert.deepEqual(f.read().labels.sort(), [
    f.policy.labels.epic, f.policy.labels.synced, f.policy.labels.blocked,
    'team:manual', 'workflow:unmanaged',
  ].sort());
});

test('a publish blocked by review approval leaves the issue and labels untouched', t => {
  const f = fixture(t, { status: 'ready', review: 'requested' });
  const before = f.read();
  assert.throws(() => coordination.applyPublish('fixture/repo', 7, {}, { policy: f.policy }),
    /review approval required/);
  assert.deepEqual(f.read(), before);
  assert.ok(f.calls().every(args => args[1] === 'view'));
});

test('open dependencies prevent publication and unblocking without changing custom labels', t => {
  const f = fixture(t, { status: 'blocked', review: 'approved', dependencies: [7] });
  const before = f.read();
  assert.throws(() => coordination.applyPublish('fixture/repo', 7, {}, { policy: f.policy }),
    /not ready to publish/);
  assert.equal(coordination.applyUnblock('fixture/repo', {}, { policy: f.policy }).count, 0);
  assert.deepEqual(f.read(), before);
  assert.ok(f.calls().every(args => ['view', 'list'].includes(args[1])));
});

test('default labels still replace old statuses and preserve unrelated labels', t => {
  const f = fixture(t, {}, false);
  coordination.applyClaim('fixture/repo', 7, {}, { policy: f.policy });
  assert.deepEqual(f.read().labels.sort(), [
    'epic', 'coordination:synced', 'coordination:claimed', 'team:manual', 'workflow:unmanaged',
  ].sort());
});

test('already synchronized custom labels need no GitHub write', t => {
  const f = fixture(t, { status: 'ready' });
  const issue = { ...f.issue, labels: [f.policy.labels.epic, f.policy.labels.synced, f.policy.labels.ready, 'team:manual'] };
  assert.deepEqual(coordination.syncIssueLabels('fixture/repo', issue, { status: 'ready' }, f.policy), {
    addLabels: [], removeLabels: [],
  });
  assert.deepEqual(f.calls(), []);
});

test('the CLI keeps custom labels consistent through a complete review workflow', t => {
  const f = fixture(t, {});
  const steps = [
    [['claim', '7', '--actor', 'fixture-owner', '--branch', 'feature/work'], ['claimed']],
    [['review', '7', '--review', 'requested'], ['claimed', 'reviewRequested']],
    [['review', '7', '--review', 'changes-requested'], ['blocked', 'reviewChangesRequested']],
    [['unblock'], ['ready', 'reviewChangesRequested']],
    [['review', '7', '--review', 'approved'], ['ready', 'reviewApproved']],
    [['validate', '7'], ['validated', 'reviewApproved']],
    [['publish', '7'], ['published', 'validated', 'reviewApproved']],
    [['sync'], ['published', 'validated', 'reviewApproved']],
    [['decompose', '7'], ['claimed', 'validated', 'reviewApproved']],
  ];
  for (const [args, expected] of steps) {
    const result = spawnSync(process.execPath, [
      path.resolve(__dirname, '../../scripts/github-coordination.js'), ...args,
      '--repo', 'fixture/repo', '--config', f.config, '--db', path.join(f.root, 'state.db'),
    ], {
      cwd: f.root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, HOME: f.root, USERPROFILE: f.root },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Repo: fixture\/repo/);
    assert.deepEqual(f.read().labels.sort(), [
      ...['epic', 'synced', ...expected].map(key => f.policy.labels[key]),
      'team:manual', 'workflow:unmanaged',
    ].sort(), args.join(' '));
  }
});
