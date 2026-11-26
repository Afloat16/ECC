'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const observer = require('../../scripts/lib/observer-sessions');

const SCRIPT = path.resolve(__dirname, '../../scripts/hooks/evaluate-session.js');
const CONFIG = path.resolve(__dirname, '../../skills/continuous-learning/config.json');
const UTILS = path.resolve(__dirname, '../../scripts/lib/utils');
let passed = 0;
let failed = 0;

function user(index) { return JSON.stringify({ type: 'user', message: { content: `User request ${index}` } }); }

function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-eval-records-'));
  const oldHomunculus = process.env.CLV2_HOMUNCULUS_DIR;
  const oldProject = process.env.CLAUDE_PROJECT_DIR;
  try {
    const homunculus = path.join(root, 'observer');
    const sessionId = 'record-count-session';
    const config = path.join(root, 'config.json');
    const preload = path.join(root, 'config-preload.js');
    fs.writeFileSync(config, JSON.stringify({ min_session_length: 10, stop_nudge_opt_in: true }));
    // Only redirect the evaluator's config read. Transcript parsing, leases and
    // Stop delivery still run through the real CLI without shared repo writes.
    fs.writeFileSync(preload, [
      `const utils = require(${JSON.stringify(UTILS)});`,
      'const readFile = utils.readFile;',
      'utils.readFile = function (file, ...args) {',
      `  return readFile.call(this, file === ${JSON.stringify(CONFIG)} ? ${JSON.stringify(config)} : file, ...args);`,
      '};',
    ].join('\n'));
    process.env.CLV2_HOMUNCULUS_DIR = homunculus;
    process.env.CLAUDE_PROJECT_DIR = root;
    const context = observer.resolveProjectContext(root);
    observer.writeSessionLease(context, sessionId, { hook: 'SessionStart' });
    const marker = path.join(homunculus, 'delivery-markers', `claude-continuous-learning-delivered-${sessionId}`);
    const run = (lines, options = {}) => {
      const transcript = path.join(root, options.directory ? 'directory.jsonl' : 'transcript.jsonl');
      if (options.directory) fs.mkdirSync(transcript);
      else fs.writeFileSync(transcript, Array.isArray(lines) ? lines.join(options.separator || '\n') : lines);
      const result = spawnSync(process.execPath, ['--require', preload, SCRIPT], {
        cwd: root,
        env: { ...process.env, HOME: root, USERPROFILE: root, ECC_AGENT_DATA_HOME: path.join(root, 'profile'), CLAUDE_CONFIG_DIR: path.join(root, 'profile') },
        input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: root, hook_event_name: 'Stop', stop_hook_active: false }),
        encoding: 'utf8', timeout: 10000,
      });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 0, result.stderr);
      return result;
    };
    fn({ run, marker });
    passed++; console.log(`  PASS ${name}`);
  } catch (error) {
    failed++; console.log(`  FAIL ${name}: ${error.message}`);
  } finally {
    if (oldHomunculus === undefined) delete process.env.CLV2_HOMUNCULUS_DIR;
    else process.env.CLV2_HOMUNCULUS_DIR = oldHomunculus;
    if (oldProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = oldProject;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('nested user metadata cannot trigger a learning nudge after one user turn', ({ run, marker }) => {
  const lines = [user(1), ...Array.from({ length: 9 }, () => JSON.stringify({ type: 'assistant', metadata: { type: 'user' } }))];
  const result = run(lines);
  assert.strictEqual(result.stdout, '');
  assert.match(result.stderr, /too short \(1 messages\)/);
  assert.ok(!fs.existsSync(marker));
});

test('arrays, malformed records and overwritten type keys are not user records', ({ run, marker }) => {
  const lines = Array.from({ length: 5 }, () => [
    '[{"type":"user"}]', '{"type":"user"', '{"type":"user","type":"assistant"}', 'null', '42', 'true',
  ]).flat();
  const result = run(lines);
  assert.strictEqual(result.stdout, '');
  assert.match(result.stderr, /too short \(0 messages\)/);
  assert.ok(!fs.existsSync(marker));
});

test('escaped JSON keys and values still count as real user records', ({ run }) => {
  const result = run(Array.from({ length: 10 }, () => '{"t\\u0079pe":"u\\u0073er","message":{"content":"request"}}'));
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.decision, 'block');
  assert.match(output.reason, /10 messages/);
});

test('one user record counts once even when its nested data repeats user types', ({ run, marker }) => {
  const result = run([JSON.stringify({ type: 'user', data: Array.from({ length: 20 }, () => ({ type: 'user' })) })]);
  assert.strictEqual(result.stdout, '');
  assert.match(result.stderr, /too short \(1 messages\)/);
  assert.ok(!fs.existsSync(marker));
});

test('ten ordinary records preserve native Stop delivery and once-per-session state', ({ run, marker }) => {
  const lines = Array.from({ length: 10 }, (_, i) => user(i));
  const first = run(lines);
  assert.match(JSON.parse(first.stdout).reason, /10 messages/);
  assert.ok(fs.existsSync(marker));
  assert.strictEqual(run(lines).stdout, '');
});

test('blank and CRLF lines preserve the threshold and unterminated final record', ({ run }) => {
  const result = run(['', ...Array.from({ length: 10 }, (_, i) => user(i))], { separator: '\r\n' });
  assert.match(JSON.parse(result.stdout).reason, /10 messages/);
});

test('a truncated final record does not push a short session over the threshold', ({ run, marker }) => {
  const result = run([...Array.from({ length: 9 }, (_, i) => user(i)), '{"type":"user"']);
  assert.strictEqual(result.stdout, '');
  assert.match(result.stderr, /too short \(9 messages\)/);
  assert.ok(!fs.existsSync(marker));
});

test('a transcript read failure cannot publish a delivery marker', ({ run, marker }) => {
  const result = run([], { directory: true });
  assert.strictEqual(result.stdout, '');
  assert.ok(!fs.existsSync(marker));
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
