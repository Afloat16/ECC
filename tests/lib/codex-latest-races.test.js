'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { findLatestRollout } = require('../../scripts/lib/session-adapters/codex-worktree');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-rollout-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = path.join(dir, 'sessions');
  fs.mkdirSync(sessions);
  const files = ['older', 'newer'].map((id, index) => {
    const file = path.join(sessions, `rollout-2026-11-26-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
    fs.utimesSync(file, 1700000000 + index, 1700000000 + index);
    return file;
  });
  return { dir, sessions, files };
}

function afterListing(sessions, mutate, fn) {
  const original = fs.readdirSync;
  let changed = false;
  fs.readdirSync = function (...args) {
    const entries = original.apply(this, args);
    if (!changed && args[0] === sessions) {
      changed = true;
      mutate();
    }
    return entries;
  };
  try { return fn(); } finally { fs.readdirSync = original; }
}

for (const removed of [0, 1]) {
  test(`session-inspect survives removal of the ${removed ? 'newest' : 'older'} enumerated rollout`, t => {
    const { dir, sessions, files } = fixture(t);
    const preload = path.join(dir, 'remove-after-list.cjs');
    fs.writeFileSync(preload, `const fs = require('node:fs');
      const original = fs.readdirSync;
      let removed = false;
      fs.readdirSync = function (...args) {
        const entries = original.apply(this, args);
        if (!removed && args[0] === ${JSON.stringify(sessions)}) {
          removed = true; fs.unlinkSync(${JSON.stringify(files[removed])});
        }
        return entries;
      };`);
    const result = spawnSync(process.execPath, ['--require', preload,
      path.resolve(__dirname, '../../scripts/session-inspect.js'), 'codex:latest'], {
      encoding: 'utf8', env: { ...process.env, CODEX_SESSIONS_DIR: sessions, HOME: dir,
        USERPROFILE: dir, TMPDIR: dir, TMP: dir, TEMP: dir }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).session.id, removed ? 'older' : 'newer');
    assert.equal(fs.existsSync(files[removed]), false);
  });
}

test('no remaining files produces the ordinary no-session result', t => {
  const { sessions, files } = fixture(t);
  const result = afterListing(sessions, () => files.forEach(file => fs.unlinkSync(file)),
    () => findLatestRollout(sessions));
  assert.equal(result, null);
});

test('a listed file replaced by a directory cannot become the selected rollout', t => {
  const { sessions, files } = fixture(t);
  const selected = afterListing(sessions, () => {
    fs.unlinkSync(files[1]);
    fs.mkdirSync(files[1]);
  }, () => findLatestRollout(sessions));
  assert.equal(selected, files[0]);
});

test('readable candidates retain newest-mtime selection and stable ties', t => {
  const { sessions, files } = fixture(t);
  assert.equal(findLatestRollout(sessions), files[1]);
  files.forEach(file => fs.utimesSync(file, 1700000000, 1700000000));
  const first = fs.readdirSync(sessions).find(name => name.endsWith('.jsonl'));
  assert.equal(findLatestRollout(sessions), path.join(sessions, first));
  assert.equal(findLatestRollout(path.join(sessions, 'missing')), null);
});
