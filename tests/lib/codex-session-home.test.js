'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '../..');
const inspect = path.join(root, 'scripts/session-inspect.js');
const adapterPath = path.join(root, 'scripts/lib/session-adapters/codex-worktree.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-codex-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, TMPDIR: dir, TMP: dir,
    TEMP: dir, CODEX_HOME: '', CODEX_SESSIONS_DIR: '', ECC_STATE_STORE_PATH: path.join(dir, 'state.db') };
  function write(sessionsDir, id) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, `rollout-2026-11-26-${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'session_meta',
      payload: { id, timestamp: '2026-11-26T00:00:00Z' } }) + '\n');
    return file;
  }
  return { dir, env, write };
}

function run(args, env, cwd) {
  const result = spawnSync(process.execPath, args, { env, cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const target of ['latest', 'custom-id']) {
  test(`session-inspect finds ${target} in the selected CODEX_HOME`, t => {
    const { dir, env, write } = fixture(t);
    const codexHome = path.join(dir, 'profile with spaces');
    write(path.join(dir, '.codex/sessions'), 'wrong-profile');
    write(path.join(codexHome, 'sessions/2026/11/26'), 'custom-id');
    const snapshot = run([inspect, `codex:${target}`], { ...env, CODEX_HOME: codexHome }, dir);
    assert.equal(snapshot.session.id, 'custom-id');
  });
}

test('CODEX_SESSIONS_DIR keeps precedence over CODEX_HOME', t => {
  const { dir, env, write } = fixture(t);
  const sessions = path.join(dir, 'explicit-sessions');
  write(sessions, 'explicit-id');
  const snapshot = run([inspect, 'codex:latest'], {
    ...env, CODEX_HOME: path.join(dir, 'unused-home'), CODEX_SESSIONS_DIR: sessions
  }, dir);
  assert.equal(snapshot.session.id, 'explicit-id');
});

test('an empty CODEX_HOME retains the standard home directory', t => {
  const { dir, env, write } = fixture(t);
  write(path.join(dir, '.codex/sessions'), 'default-id');
  assert.equal(run([inspect, 'codex:latest'], env, dir).session.id, 'default-id');
});

test('a relative CODEX_HOME is resolved from the working directory', t => {
  const { dir, env, write } = fixture(t);
  write(path.join(dir, 'relative-profile/sessions'), 'relative-id');
  assert.equal(run([inspect, 'codex:latest'], { ...env, CODEX_HOME: 'relative-profile' }, dir).session.id,
    'relative-id');
});

for (const source of ['options', 'context']) {
  test(`${source} session directory keeps precedence over environment paths`, t => {
    const { dir, env, write } = fixture(t);
    const sessions = path.join(dir, 'explicit');
    write(sessions, 'configured-id');
    const code = `const { createCodexWorktreeAdapter } = require(${JSON.stringify(adapterPath)});
      const options = { persistSnapshots: false };
      const context = {};
      ${source === 'options' ? 'options.sessionsDir' : 'context.codexSessionsDir'} = ${JSON.stringify(sessions)};
      console.log(JSON.stringify(createCodexWorktreeAdapter(options).open('codex:latest', context).getSnapshot()));`;
    const snapshot = run(['-e', code], { ...env, CODEX_HOME: path.join(dir, 'unused'),
      CODEX_SESSIONS_DIR: path.join(dir, 'unused-sessions') }, dir);
    assert.equal(snapshot.session.id, 'configured-id');
  });
}
