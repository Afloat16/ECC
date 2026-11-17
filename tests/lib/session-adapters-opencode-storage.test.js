'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const adapterPath = path.join(__dirname, '..', '..', 'scripts', 'lib', 'session-adapters', 'opencode.js');
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

function writeSession(storageDir, sessionId) {
  const sessionDir = path.join(storageDir, 'session', 'project');
  const messageDir = path.join(storageDir, 'message', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(messageDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${sessionId}.json`), JSON.stringify({
    id: sessionId, title: 'Stored project work', time: { created: 1, updated: 2 },
  }));
  fs.writeFileSync(path.join(messageDir, 'msg_001.json'), JSON.stringify({
    role: 'assistant', modelID: `${sessionId}-model`, providerID: 'provider',
  }));
}

function withStores(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-opencode-storage-'));
  try {
    const home = path.join(root, 'home');
    const xdg = path.join(root, 'data space café');
    const legacy = path.join(home, '.local', 'share', 'opencode', 'storage');
    const custom = path.join(root, 'explicit');
    writeSession(legacy, 'ses_legacy');
    writeSession(path.join(xdg, 'opencode', 'storage'), 'ses_xdg');
    writeSession(custom, 'ses_explicit');
    const run = ({ env: overrides = {}, options = {}, context = {} } = {}) => {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      delete env.XDG_DATA_HOME;
      delete env.OPENCODE_STORAGE_DIR;
      Object.assign(env, overrides);
      const code = [
        `const { createOpencodeAdapter } = require(${JSON.stringify(adapterPath)});`,
        `const adapter = createOpencodeAdapter({ persistSnapshots: false, ...${JSON.stringify(options)} });`,
        `const snapshot = adapter.open('opencode:latest', ${JSON.stringify(context)}).getSnapshot();`,
        'process.stdout.write(JSON.stringify(snapshot));',
      ].join('\n');
      return spawnSync(process.execPath, ['-e', code], {
        cwd: root, env, encoding: 'utf8', timeout: 15000,
      });
    };
    fn({ root, home, xdg, legacy, custom, run });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function expectSession(result, id) {
  assert.strictEqual(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.strictEqual(snapshot.session.id, id);
  assert.strictEqual(snapshot.workers[0].artifacts.model, `${id}-model`);
}

test('discovers sessions and messages under absolute XDG_DATA_HOME', () => {
  withStores(({ xdg, run }) => expectSession(run({ env: { XDG_DATA_HOME: xdg } }), 'ses_xdg'));
});

test('a configured XDG store does not silently fall back to another home store', () => {
  withStores(({ root, run }) => {
    const result = run({ env: { XDG_DATA_HOME: path.join(root, 'empty-data') } });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /No OpenCode sessions found/);
  });
});

for (const value of [undefined, '', 'relative-data']) {
  test(`unset, empty or relative XDG_DATA_HOME keeps the default (${String(value)})`, () => {
    withStores(({ run }) => expectSession(run({
      env: value === undefined ? {} : { XDG_DATA_HOME: value },
    }), 'ses_legacy'));
  });
}

test('OPENCODE_STORAGE_DIR retains precedence over XDG_DATA_HOME', () => {
  withStores(({ xdg, custom, run }) => expectSession(run({
    env: { XDG_DATA_HOME: xdg, OPENCODE_STORAGE_DIR: custom },
  }), 'ses_explicit'));
});

test('per-open storage overrides retain precedence over both environment settings', () => {
  withStores(({ xdg, legacy, custom, run }) => expectSession(run({
    env: { XDG_DATA_HOME: xdg, OPENCODE_STORAGE_DIR: legacy },
    context: { opencodeStorageDir: custom },
  }), 'ses_explicit'));
});

test('adapter storage options retain precedence over context and environment', () => {
  withStores(({ xdg, legacy, custom, run }) => expectSession(run({
    env: { XDG_DATA_HOME: xdg, OPENCODE_STORAGE_DIR: legacy },
    context: { opencodeStorageDir: legacy },
    options: { storageDir: custom },
  }), 'ses_explicit'));
});

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
