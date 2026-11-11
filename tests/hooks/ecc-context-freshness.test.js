'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function createSession(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-context-freshness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const temp = path.join(home, 'tmp');
  fs.mkdirSync(temp);
  const sessionId = 'context-freshness';
  const bridgePath = path.join(temp, `ecc-metrics-${sessionId}.json`);
  const toolInput = { session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'pwd' } };
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, ECC_AGENT_DATA_HOME: path.join(home, '.claude'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    TMPDIR: temp, TEMP: temp, TMP: temp, ECC_STATUSLINE_USAGE: '0',
    ECC_CONTEXT_MONITOR_COST_WARNINGS: '1'
  };
  return {
    toolInput,
    statusInput: { session_id: sessionId, workspace: { current_dir: home } },
    writeBridge: bridge => fs.writeFileSync(bridgePath, JSON.stringify(bridge)),
    readBridge: () => JSON.parse(fs.readFileSync(bridgePath, 'utf8')),
    invoke(name, input) {
      const result = spawnSync(process.execPath, [path.resolve(__dirname, `../../scripts/hooks/${name}.js`)], {
        input: JSON.stringify(input), encoding: 'utf8', env, cwd: home, timeout: 5000
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    }
  };
}

test('statusline dates its context observation independently of old tool activity', t => {
  const session = createSession(t);
  const oldToolTimestamp = new Date(Date.now() - 120000).toISOString();
  session.writeBridge({ last_timestamp: oldToolTimestamp, tool_count: 3 });
  const started = Date.now();
  const output = session.invoke('ecc-statusline', {
    ...session.statusInput, context_window: { remaining_percentage: 20 }
  });
  assert.match(output, /%/);
  const bridge = session.readBridge();
  assert.equal(bridge.context_remaining_pct, 20);
  assert.ok(Date.parse(bridge.context_timestamp) >= started, 'The observation needs its own current timestamp');
  assert.ok(Date.parse(bridge.context_timestamp) <= Date.now());
  assert.equal(bridge.last_timestamp, oldToolTimestamp, 'Rendering must not invent tool activity');
  const monitor = JSON.parse(session.invoke('ecc-context-monitor', session.toolInput));
  assert.match(monitor.hookSpecificOutput?.additionalContext || '', /CONTEXT CRITICAL/);
});

test('tool activity cannot refresh stale context, while scope warnings remain active', t => {
  const session = createSession(t);
  const oldContextTimestamp = new Date(Date.now() - 120000).toISOString();
  session.writeBridge({
    context_remaining_pct: 20, context_timestamp: oldContextTimestamp,
    last_timestamp: oldContextTimestamp, files_modified_count: 21,
    files_modified: Array.from({ length: 21 }, (_, index) => `file-${index}.js`)
  });
  session.invoke('ecc-metrics-bridge', session.toolInput);
  const bridge = session.readBridge();
  assert.ok(Date.parse(bridge.last_timestamp) > Date.parse(oldContextTimestamp));
  assert.equal(bridge.context_timestamp, oldContextTimestamp);
  const monitor = JSON.parse(session.invoke('ecc-context-monitor', session.toolInput));
  const context = monitor.hookSpecificOutput?.additionalContext || '';
  assert.doesNotMatch(context, /CONTEXT/);
  assert.match(context, /SCOPE WARNING/);
});

for (const stale of [false, true]) {
  test(`legacy bridge uses the tool timestamp when no context timestamp exists (stale=${stale})`, t => {
    const session = createSession(t);
    session.writeBridge({
      context_remaining_pct: 20,
      last_timestamp: new Date(Date.now() - (stale ? 120000 : 0)).toISOString()
    });
    const monitor = JSON.parse(session.invoke('ecc-context-monitor', session.toolInput));
    const context = monitor.hookSpecificOutput?.additionalContext || '';
    if (stale) assert.equal(context, '');
    else assert.match(context, /CONTEXT CRITICAL/);
  });
}

test('statusline without a context reading leaves the previous observation untouched', t => {
  const session = createSession(t);
  const previous = {
    context_remaining_pct: 20,
    context_timestamp: new Date(Date.now() - 120000).toISOString(),
    last_timestamp: new Date().toISOString()
  };
  session.writeBridge(previous);
  session.invoke('ecc-statusline', session.statusInput);
  assert.deepEqual(session.readBridge(), previous);
  session.invoke('ecc-statusline', { ...session.statusInput, context_window: { remaining_percentage: null } });
  assert.deepEqual(session.readBridge(), previous);
});
