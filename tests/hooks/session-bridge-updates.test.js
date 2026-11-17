'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const hookDirectory = path.resolve(__dirname, '../../scripts/hooks');

async function concurrentHooks(t, types) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-bridge-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temporary = path.join(root, 'tmp');
  const ready = path.join(root, 'ready');
  fs.mkdirSync(temporary);
  fs.mkdirSync(ready);
  const sessionId = 'concurrent-session';
  const bridgePath = path.join(temporary, `ecc-metrics-${sessionId}.json`);
  const gate = path.join(root, 'start');
  const initial = { session_id: sessionId, tool_count: 0, files_modified: [], recent_tools: [], context_remaining_pct: null };
  fs.writeFileSync(bridgePath, JSON.stringify(initial));

  // Run the real hooks in separate processes. Widen the interval after each
  // real bridge read to make stale read/modify/write interleavings observable.
  const preload = path.join(root, 'coordinate.cjs');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
    'const originalRead = fs.readFileSync;',
    'fs.readFileSync = function(file, ...args) {',
    '  const value = originalRead.call(this, file, ...args);',
    '  if (String(file) === process.env.ECC_TEST_BRIDGE_PATH) pause(40);',
    '  return value;',
    '};',
    "fs.writeFileSync(path.join(process.env.ECC_TEST_READY_DIR, String(process.pid)), 'ready');",
    'const deadline = Date.now() + 5000;',
    'while (!fs.existsSync(process.env.ECC_TEST_START_FILE)) {',
    "  if (Date.now() > deadline) throw new Error('Concurrent hook start timed out');",
    '  pause(5);',
    '}',
  ].join('\n'));

  const env = {
    ...process.env, HOME: root, USERPROFILE: root, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    ECC_AGENT_DATA_HOME: path.join(root, '.claude'), CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
    ECC_STATUSLINE_USAGE: '0', ECC_TEST_BRIDGE_PATH: bridgePath,
    ECC_TEST_READY_DIR: ready, ECC_TEST_START_FILE: gate,
  };
  delete env.XDG_DATA_HOME;
  const children = types.map((type, index) => {
    const hook = type === 'metrics' ? 'ecc-metrics-bridge.js' : 'ecc-statusline.js';
    const input = type === 'metrics'
      ? { session_id: sessionId, tool_name: 'Write', tool_input: { file_path: `changed-${index}.js` } }
      : { session_id: sessionId, workspace: { current_dir: root }, context_window: { remaining_percentage: 25 } };
    const child = spawn(process.execPath, ['--require', preload, path.join(hookDirectory, hook)], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(JSON.stringify(input));
    const completed = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stderr, stdout, input, type }));
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return completed;
  });

  const deadline = Date.now() + 5000;
  while (fs.readdirSync(ready).length < types.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  fs.writeFileSync(gate, 'start');
  const results = await Promise.all(children);
  for (const result of results) {
    assert.equal(result.code, 0, `${result.type}: ${result.stderr} ${result.signal || ''}`);
    if (result.type === 'metrics') assert.deepEqual(JSON.parse(result.stdout), result.input);
  }
  assert.equal(fs.readdirSync(ready).length, types.length);
  return JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
}

test('concurrent PostToolUse hooks retain every tool count and modified file', async t => {
  const bridge = await concurrentHooks(t, Array(8).fill('metrics'));
  assert.equal(bridge.tool_count, 8);
  assert.equal(bridge.files_modified_count, 8);
  assert.deepEqual([...bridge.files_modified].sort(), Array.from({ length: 8 }, (_, i) => `changed-${i}.js`));
  assert.equal(bridge.recent_tools.length, 5);
});

test('statusline context writes preserve concurrent metric updates', async t => {
  const bridge = await concurrentHooks(t, ['metrics', 'status', 'metrics', 'status', 'metrics', 'status']);
  assert.equal(bridge.tool_count, 3);
  assert.equal(bridge.files_modified_count, 3);
  assert.deepEqual([...bridge.files_modified].sort(), ['changed-0.js', 'changed-2.js', 'changed-4.js']);
  assert.equal(bridge.context_remaining_pct, 25);
});
