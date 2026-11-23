'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { collectChanges } = require('../../scripts/lib/astra-review/scope');

const ROOT = path.resolve('/repo');
const LARGE_PREFIX = 'src/large-';

// Count numeric reads performed by native linear lookups on the path arrays.
// This checks the identified scan cost without depending on wall-clock timing
// or requiring a particular replacement collection. Restore synchronously.
function countPathScans(fn) {
  let visits = 0;
  const originals = { indexOf: Array.prototype.indexOf, includes: Array.prototype.includes };
  for (const [name, original] of Object.entries(originals)) {
    Array.prototype[name] = function (value, ...rest) {
      if (!Array.isArray(this) || this.length < 64
        || typeof value !== 'string' || !value.startsWith(LARGE_PREFIX)) {
        return original.call(this, value, ...rest);
      }
      const tracked = new Proxy(this, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)) visits += 1;
          return Reflect.get(target, key, receiver);
        }
      });
      return original.call(tracked, value, ...rest);
    };
  }
  try {
    const result = fn();
    return { result, visits };
  } finally {
    Object.assign(Array.prototype, originals);
  }
}

const nul = values => values.join('\0') + (values.length ? '\0' : '');

function workingTree(staged, unstaged, untracked) {
  const runGit = args => {
    const command = args.join(' ');
    if (command === 'rev-parse --show-toplevel') return ROOT + '\n';
    if (command === 'rev-parse -q --verify HEAD^{commit}') return 'abc1234\n';
    if (command === 'diff --cached --name-only -z HEAD --') return nul(staged);
    if (command === 'diff --name-only -z --') return nul(unstaged);
    if (command === 'ls-files --others --exclude-standard -z') return nul(untracked);
    if (args[0] === 'diff') return '+working-tree patch\n';
    throw new Error('Unexpected Git command: ' + command);
  };
  return collectChanges({ kind: 'uncommitted', value: null }, { cwd: ROOT, runGit });
}

function repair(paths) {
  const kinds = new Map(paths.map((file, index) => [file, index % 4]));
  const relative = file => path.relative(ROOT, file).split(path.sep).join('/');
  const runGit = args => {
    const command = args.join(' ');
    if (command === 'rev-parse --show-toplevel') return ROOT + '\n';
    if (command === 'rev-parse --verify --end-of-options HEAD^{commit}') return 'abc1234\n';
    if (command === 'rev-list --parents -n 1 abc1234') return 'abc1234 123abcd\n';
    if (command === 'diff --no-renames --name-only -z 123abcd abc1234 --') return nul(paths);
    if (args[0] === 'diff') return '-prior content\n';
    throw new Error('Unexpected Git command: ' + command);
  };
  const lstatSync = file => {
    const kind = kinds.get(relative(file));
    if (kind === undefined || kind === 2) throw Object.assign(new Error('Missing fixture path'), { code: 'ENOENT' });
    return { isFile: () => kind === 0, isDirectory: () => kind === 1, isSymbolicLink: () => kind === 3 };
  };
  return collectChanges({ kind: 'files-from-commit', value: 'HEAD' }, {
    cwd: ROOT, runGit, lstatSync, realpathSync: file => file,
    readFile: file => 'Current ' + relative(file), readlinkSync: () => 'link-target.txt'
  });
}

test('large working-tree inventories preserve first occurrence without repeated full-prefix scans', () => {
  const staged = Array.from({ length: 512 }, (_, index) => LARGE_PREFIX + index + '.js');
  const unstaged = [...staged].reverse();
  const untracked = ['new file.txt'];
  const measured = countPathScans(() => workingTree(staged, unstaged, untracked));
  assert.deepEqual(measured.result.files, [...staged, ...untracked]);
  assert.ok(measured.visits <= 4 * (staged.length + unstaged.length + untracked.length),
    'Path lookups revisited ' + measured.visits + ' entries');
});

test('large repair inventories classify regular, linked, directory and absent paths with bounded scans', () => {
  const paths = Array.from({ length: 512 }, (_, index) => LARGE_PREFIX + index + '.js');
  const measured = countPathScans(() => repair(paths));
  const present = paths.filter((_, index) => index % 4 === 0 || index % 4 === 3);
  const directories = paths.filter((_, index) => index % 4 === 1);
  const absent = paths.filter((_, index) => index % 4 === 2);
  assert.deepEqual(measured.result.files, [...present, ...directories, ...absent]);
  assert.ok(measured.result.diff.includes('Current ' + paths[0]));
  assert.ok(measured.result.diff.includes('(symlink -> link-target.txt)'));
  assert.ok(measured.result.diff.includes('directory or submodule'));
  assert.ok(measured.result.diff.includes('absent now; deletion relative to 123abcd'));
  assert.ok(measured.visits <= 8 * paths.length, 'Path lookups revisited ' + measured.visits + ' entries');
});

test('working-tree inventories retain exact path identity and first-seen ordering', () => {
  const staged = ['__proto__', 'A.js', 'a.js', ' space.js', 'constructor'];
  const unstaged = ['a.js', '__proto__', 'toString', 'A.js'];
  const untracked = ['space.js', 'new\nline.js', 'new\tfile.js'];
  assert.deepEqual(workingTree(staged, unstaged, untracked).files,
    [...staged, 'toString', ...untracked]);
});

test('empty repair inventories remain empty', () => {
  const result = repair([]);
  assert.deepEqual(result.files, []);
  assert.equal(result.diff, '');
});

test('the public CLI keeps a path shared by index and working tree once, followed by untracked files', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-astra-inventory-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const config = path.join(temp, 'gitconfig');
  fs.writeFileSync(config, '[maintenance]\n  auto = false\n[gc]\n  auto = 0\n');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config
  };
  const run = (program, args) => {
    const result = spawnSync(program, args, { cwd: repo, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run('git', ['init', '-q']);
  run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test',
    'commit', '--allow-empty', '-qm', 'Empty root']);
  for (const file of ['README x.md', '--literal.txt']) fs.writeFileSync(path.join(repo, file), 'Staged.\n');
  run('git', ['add', '--', 'README x.md', '--literal.txt']);
  fs.writeFileSync(path.join(repo, 'README x.md'), 'Unstaged.\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'Untracked.\n');
  const output = run(process.execPath, [path.resolve(__dirname, '../../scripts/astra-review.js'), '--dry-run']);
  const inventory = output.split('Files under review:\n')[1].split('\n\n')[0].split('\n');
  assert.deepEqual(inventory, ['- --literal.txt', '- README x.md', '- untracked.txt']);
  assert.ok(output.includes('+Staged.'));
  assert.ok(output.includes('+Unstaged.'));
  assert.ok(output.includes('+Untracked.'));
});
