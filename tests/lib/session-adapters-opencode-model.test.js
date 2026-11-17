'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpencodeAdapter, parseOpencodeSession } = require('../../scripts/lib/session-adapters/opencode');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
    failed += 1;
  }
}

function withMessages(messages, fn) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-opencode-model-'));
  try {
    const sessionId = 'ses_model_history';
    const sessionDir = path.join(storageDir, 'session', 'project');
    const messageDir = path.join(storageDir, 'message', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(messageDir, { recursive: true });
    const sessionInfoPath = path.join(sessionDir, `${sessionId}.json`);
    fs.writeFileSync(sessionInfoPath, JSON.stringify({
      id: sessionId, title: 'Continue project work', time: { created: 1, updated: 2 },
    }));
    // Message IDs ascend with time in OpenCode's JSON storage. Create in reverse order
    // so the result cannot rely on directory insertion order.
    messages.map((message, index) => ({ message, index })).reverse().forEach(({ message, index }) => {
      const id = `msg_${(index + 1).toString(16).padStart(12, '0')}00000000000000`;
      fs.writeFileSync(path.join(messageDir, `${id}.json`), typeof message === 'string'
        ? message
        : JSON.stringify({ id, sessionID: sessionId, ...message }));
    });
    fn({
      parse: () => parseOpencodeSession(sessionInfoPath, { storageDir, resolveBranchImpl: () => null }),
      snapshot: () => createOpencodeAdapter({ storageDir, persistSnapshots: false })
        .open(`opencode:${sessionId}`).getSnapshot(),
    });
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
}

const oldAssistant = { role: 'assistant', modelID: 'old-model', providerID: 'old-provider' };
const newAssistant = { role: 'assistant', modelID: 'new-model', providerID: 'new-provider' };

test('session snapshots reflect the most recent assistant model and provider', () => {
  withMessages([oldAssistant, newAssistant], ({ parse, snapshot }) => {
    assert.strictEqual(parse().model, 'new-model');
    assert.strictEqual(parse().provider, 'new-provider');
    const artifacts = snapshot().workers[0].artifacts;
    assert.strictEqual(artifacts.model, 'new-model');
    assert.strictEqual(artifacts.provider, 'new-provider');
    assert.strictEqual(artifacts.messageCount, 2);
  });
});

test('model changes beyond the first forty messages are discovered', () => {
  withMessages([...Array(45).fill(oldAssistant), newAssistant], ({ parse }) => {
    assert.strictEqual(parse().model, 'new-model');
    assert.strictEqual(parse().messageCount, 46);
  });
});

test('a trailing user turn does not hide the newest assistant metadata', () => {
  withMessages([oldAssistant, newAssistant, { role: 'user' }], ({ parse }) => {
    assert.strictEqual(parse().model, 'new-model');
  });
});

test('malformed recent files do not force metadata back to the first assistant', () => {
  withMessages([oldAssistant, newAssistant, '{ incomplete'], ({ parse }) => {
    assert.strictEqual(parse().model, 'new-model');
    assert.strictEqual(parse().messageCount, 3);
  });
});

test('an assistant without a usable model is skipped within the recent window', () => {
  withMessages([oldAssistant, newAssistant, { role: 'assistant', modelID: '' }], ({ parse }) => {
    assert.strictEqual(parse().model, 'new-model');
  });
});

test('missing provider on the latest assistant does not reuse the old provider', () => {
  withMessages([oldAssistant, { role: 'assistant', modelID: 'new-model' }], ({ parse }) => {
    assert.strictEqual(parse().model, 'new-model');
    assert.strictEqual(parse().provider, null);
  });
});

test('the forty-message read bound applies to the newest messages', () => {
  withMessages([oldAssistant, ...Array(40).fill({ role: 'user' })], ({ parse }) => {
    assert.strictEqual(parse().model, null);
    assert.strictEqual(parse().provider, null);
    assert.strictEqual(parse().messageCount, 41);
  });
});

test('one assistant and empty histories keep their existing behavior', () => {
  withMessages([oldAssistant], ({ parse }) => {
    assert.strictEqual(parse().model, 'old-model');
    assert.strictEqual(parse().provider, 'old-provider');
  });
  withMessages([], ({ parse }) => {
    assert.strictEqual(parse().model, null);
    assert.strictEqual(parse().messageCount, 0);
  });
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
