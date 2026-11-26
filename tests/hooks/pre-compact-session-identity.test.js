'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../../scripts/hooks/pre-compact.js');
const FIRST = 'aaaaaaaa-1111-2222-3333-4444aaaabbbb';
const SECOND = 'bbbbbbbb-1111-2222-3333-4444ccccdddd';
let passed = 0;
let failed = 0;

function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-compact-id-'));
  try {
    const project = path.join(root, 'project');
    const profile = path.join(root, 'profile');
    const sessions = path.join(profile, 'session-data');
    fs.mkdirSync(project);
    fs.mkdirSync(sessions, { recursive: true });
    const create = (id, worktree = project, age = 0, legacy = false) => {
      const name = `2026-01-01-${id}-session.tmp`;
      const file = path.join(sessions, name);
      const content = `# Session\n**Project:** project\n${legacy ? '' : `**Worktree:** ${worktree}\n`}\nOriginal ${id}\n`;
      fs.writeFileSync(file, content);
      const time = new Date(Date.now() - age);
      fs.utimesSync(file, time, time);
      return { file, content, read: () => fs.readFileSync(file, 'utf8') };
    };
    const run = (payload, overrides = {}, summary, script = SCRIPT) => {
      const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: profile, ECC_AGENT_DATA_HOME: profile };
      for (const key of ['CLAUDE_SESSION_ID', 'ECC_SESSION_ID', 'CLAUDE_TRANSCRIPT_PATH', 'CLAUDE_PROJECT_DIR']) delete env[key];
      Object.assign(env, overrides);
      const args = [];
      if (summary !== undefined) {
        const preload = path.join(root, 'summary-preload.js');
        fs.writeFileSync(preload, `require(${JSON.stringify(path.resolve(__dirname, '../../scripts/lib/llm-summary.js'))}).generateSessionSummary = () => ${JSON.stringify(summary)};`);
        args.push('-r', preload);
      }
      const child = spawnSync(process.execPath, [...args, script], {
        cwd: project, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(child.error);
      assert.strictEqual(child.status, 0, child.stderr);
      assert.strictEqual(child.stdout, '');
      return child;
    };
    const record = (payload, overrides) => run(payload, {
      ECC_SKIP_LLM_SUMMARY: '1', ...overrides,
    }, undefined, path.resolve(__dirname, '../../scripts/hooks/session-end.js'));
    fn({ root, project, sessions, create, run, record });
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}: ${error.message}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('compaction annotates its older session instead of another session in the same worktree', ({ root, create, run }) => {
  const own = create('aaaabbbb', undefined, 20000);
  const other = create('ccccdddd');
  run({ session_id: FIRST, transcript_path: path.join(root, `${FIRST}.jsonl`) });
  assert.match(own.read(), /Compaction occurred/);
  assert.strictEqual(other.read(), other.content);
});

test('an identified session without a saved file never annotates its neighbor', ({ root, create, run }) => {
  const other = create('ccccdddd');
  run({ session_id: FIRST, transcript_path: path.join(root, `${FIRST}.jsonl`) });
  assert.strictEqual(other.read(), other.content);
});

test('a transcript identity wins over an inherited parent session environment', ({ root, create, run }) => {
  const own = create('aaaabbbb', undefined, 20000);
  const other = create('ccccdddd');
  run({ transcript_path: path.join(root, `${FIRST.toUpperCase()}.jsonl`) }, { CLAUDE_SESSION_ID: SECOND });
  assert.match(own.read(), /Compaction occurred/);
  assert.strictEqual(other.read(), other.content);
});

test('non-UUID inputs retain the writer legacy environment identity', ({ create, run }) => {
  const own = create('aaaabbbb', undefined, 20000);
  const other = create('ccccdddd');
  run({ session_id: SECOND }, { CLAUDE_SESSION_ID: FIRST, ECC_SESSION_ID: SECOND });
  assert.match(own.read(), /Compaction occurred/);
  assert.strictEqual(other.read(), other.content);
  fs.writeFileSync(own.file, own.content);
  run({}, { CLAUDE_SESSION_ID: FIRST });
  assert.match(own.read(), /Compaction occurred/);
  assert.strictEqual(other.read(), other.content);
});

test('matching identity cannot override a different worktree', ({ root, create, run }) => {
  const foreignRoot = path.join(root, 'foreign');
  fs.mkdirSync(foreignRoot);
  const foreign = create('aaaabbbb', foreignRoot, 20000);
  const neighbor = create('ccccdddd');
  run({ session_id: FIRST }, { CLAUDE_SESSION_ID: FIRST });
  assert.strictEqual(foreign.read(), foreign.content);
  assert.strictEqual(neighbor.read(), neighbor.content);
});

test('short ids match the whole filename field, not another id suffix', ({ create, run }) => {
  const other = create('12-abcd');
  run({ session_id: 'abcd' }, { CLAUDE_SESSION_ID: 'abcd' });
  assert.strictEqual(other.read(), other.content);
});

test('unidentified legacy invocations retain worktree and project fallback', ({ create, run }) => {
  const legacy = create('legacy', undefined, 20000, true);
  const current = create('ccccdddd');
  run({});
  assert.match(current.read(), /Compaction occurred/);
  assert.strictEqual(legacy.read(), legacy.content);
});

test('successful summary replacement updates only the identified session', ({ root, create, run }) => {
  const own = create('aaaabbbb', undefined, 20000);
  fs.appendFileSync(own.file, '<!-- ECC:SUMMARY:START -->\nold summary\n<!-- ECC:SUMMARY:END -->\n');
  const earlier = new Date(Date.now() - 20000);
  fs.utimesSync(own.file, earlier, earlier);
  const other = create('ccccdddd');
  const transcript = path.join(root, `${FIRST}.jsonl`);
  fs.writeFileSync(transcript, '{}\n');
  run({ session_id: FIRST, transcript_path: transcript }, {}, 'new summary');
  assert.match(own.read(), /new summary/);
  assert.ok(!own.read().includes('old summary'));
  assert.strictEqual(other.read(), other.content);
});

test('summary fallback appends only to the identified session', ({ root, create, run }) => {
  const own = create('aaaabbbb', undefined, 20000);
  const other = create('ccccdddd');
  const transcript = path.join(root, `${FIRST}.jsonl`);
  fs.writeFileSync(transcript, '{}\n');
  run({ transcript_path: transcript }, {}, null);
  assert.match(own.read(), /Compaction occurred/);
  assert.strictEqual(other.read(), other.content);
});

test('no saved sessions remains a clean no-op', ({ run }) => {
  assert.match(run({ session_id: FIRST }).stderr, /No active session/);
});

for (const scenario of ['uuid', 'non-uuid-payload', 'conflicting-environment']) {
  test(`real session-end output stays the compaction target: ${scenario}`, ({ root, sessions, create, run, record }) => {
    const transcript = path.join(root, scenario === 'uuid' ? `${FIRST}.jsonl` : 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'Keep the task summary' } }) + '\n');
    const payload = { transcript_path: transcript, session_id: SECOND };
    const env = scenario === 'uuid' ? {} : { CLAUDE_SESSION_ID: FIRST };
    if (scenario === 'conflicting-environment') env.ECC_SESSION_ID = SECOND;
    record(payload, env);
    const saved = fs.readdirSync(sessions).filter(name => name.endsWith('-session.tmp'));
    assert.strictEqual(saved.length, 1);
    assert.ok(saved[0].endsWith('-aaaabbbb-session.tmp'), saved[0]);
    const target = path.join(sessions, saved[0]);
    const before = fs.readFileSync(target, 'utf8');
    const neighbor = create('ccccdddd', undefined, -20000);
    run(payload, { ECC_SKIP_LLM_SUMMARY: '1', ...env });
    assert.ok(fs.readFileSync(target, 'utf8').length > before.length);
    assert.match(fs.readFileSync(target, 'utf8'), /Compaction occurred/);
    assert.strictEqual(neighbor.read(), neighbor.content);
  });
}

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
