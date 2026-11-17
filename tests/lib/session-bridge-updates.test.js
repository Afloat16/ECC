'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { getBridgePath, readBridge, updateBridgeAtomic, writeBridgeAtomic } = require('../../scripts/lib/session-bridge');
const { acquireSettingsLock } = require('../../scripts/lib/install/claude-settings-lock');
const { run } = require('../../scripts/hooks/ecc-metrics-bridge');

function fixture(t) {
  const sessionId = `bridge-update-${crypto.randomUUID()}`;
  const filePath = getBridgePath(sessionId);
  t.after(() => fs.rmSync(filePath, { recursive: true, force: true }));
  return { sessionId, filePath, lockPath: `${filePath}.ecc.lock` };
}

test('a locked update can initialize a missing bridge and returns the committed data', t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  const written = updateBridgeAtomic(sessionId, previous => {
    assert.equal(previous, null);
    return { tool_count: 1 };
  });
  assert.deepEqual(written, { tool_count: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), written);
  assert.equal(fs.existsSync(lockPath), false);
});

test('the first PostToolUse hook initializes all session metrics', t => {
  const { sessionId, filePath } = fixture(t);
  const previousDataHome = process.env.ECC_AGENT_DATA_HOME;
  process.env.ECC_AGENT_DATA_HOME = `${filePath}.home`;
  t.after(() => fs.rmSync(`${filePath}.home`, { recursive: true, force: true }));
  try {
    const input = JSON.stringify({ session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'pwd' } });
    assert.equal(run(input), input);
    const bridge = readBridge(sessionId);
    assert.equal(bridge.session_id, sessionId);
    assert.equal(bridge.tool_count, 1);
    assert.equal(bridge.total_cost_usd, 0);
    assert.equal(bridge.files_modified_count, 0);
    assert.deepEqual(bridge.files_modified, []);
    assert.equal(bridge.recent_tools.length, 1);
    assert.equal(bridge.context_remaining_pct, null);
    assert.equal(bridge.first_timestamp, bridge.last_timestamp);
  } finally {
    if (previousDataHome === undefined) delete process.env.ECC_AGENT_DATA_HOME;
    else process.env.ECC_AGENT_DATA_HOME = previousDataHome;
  }
});

test('a null update leaves both missing and existing bridges unchanged', t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  assert.equal(updateBridgeAtomic(sessionId, () => null), null);
  assert.equal(fs.existsSync(filePath), false);
  writeBridgeAtomic(sessionId, { tool_count: 7 });
  const before = fs.readFileSync(filePath);
  assert.equal(updateBridgeAtomic(sessionId, () => null), null);
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(fs.existsSync(lockPath), false);
});

test('callback failures preserve the bridge and release the lock for the next update', t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  writeBridgeAtomic(sessionId, { tool_count: 7 });
  const before = fs.readFileSync(filePath);
  const failure = new Error('update failed');
  assert.throws(() => updateBridgeAtomic(sessionId, () => { throw failure; }), error => error === failure);
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(fs.existsSync(lockPath), false);
  updateBridgeAtomic(sessionId, previous => ({ ...previous, tool_count: previous.tool_count + 1 }));
  assert.equal(readBridge(sessionId).tool_count, 8);
});

test('publication failures release the lock and do not leave a temporary bridge', t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  fs.mkdirSync(filePath);
  assert.throws(() => updateBridgeAtomic(sessionId, () => ({ tool_count: 1 })));
  assert.equal(fs.existsSync(lockPath), false);
  const leftovers = fs.readdirSync(path.dirname(filePath)).filter(name => name.startsWith(`${path.basename(filePath)}.`));
  assert.deepEqual(leftovers, []);
  fs.rmdirSync(filePath);
  updateBridgeAtomic(sessionId, () => ({ tool_count: 2 }));
  assert.equal(readBridge(sessionId).tool_count, 2);
});

test('transient publication retries keep the update lock until the bridge commits', t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  writeBridgeAtomic(sessionId, { tool_count: 2 });
  const originalRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = function(source, destination, ...args) {
    if (destination === filePath) {
      assert.equal(fs.existsSync(lockPath), true);
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('busy destination'), { code: 'EBUSY' });
    }
    return originalRename.call(this, source, destination, ...args);
  };
  try {
    updateBridgeAtomic(sessionId, previous => ({ ...previous, tool_count: 3 }));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(attempts, 3);
  assert.equal(readBridge(sessionId).tool_count, 3);
  assert.equal(fs.existsSync(lockPath), false);
});

test('exhausted publication retries preserve the original bridge and release the update lock', t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  writeBridgeAtomic(sessionId, { tool_count: 2 });
  const before = fs.readFileSync(filePath);
  const originalRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = function(source, destination, ...args) {
    if (destination === filePath) {
      attempts += 1;
      throw Object.assign(new Error('busy destination'), { code: 'EBUSY' });
    }
    return originalRename.call(this, source, destination, ...args);
  };
  try {
    assert.throws(() => updateBridgeAtomic(sessionId, () => ({ tool_count: 3 })), /busy destination/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(attempts, 5);
  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.equal(fs.existsSync(lockPath), false);
});

test('a contended bridge retains the PostToolUse pass-through and the live owner lock', { timeout: 5000 }, t => {
  const { sessionId, filePath, lockPath } = fixture(t);
  writeBridgeAtomic(sessionId, { tool_count: 9 });
  const before = fs.readFileSync(filePath);
  const release = acquireSettingsLock(filePath, { label: 'test owner' });
  try {
    const input = JSON.stringify({ session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'pwd' } });
    assert.equal(run(input), input);
    assert.deepEqual(fs.readFileSync(filePath), before);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    release();
  }
  updateBridgeAtomic(sessionId, previous => ({ ...previous, tool_count: 10 }));
  assert.equal(readBridge(sessionId).tool_count, 10);
});
