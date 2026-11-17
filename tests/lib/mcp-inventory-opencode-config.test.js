'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { readOpencodeMcp } = require('../../scripts/lib/mcp-inventory/readers/opencode');

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-config-'));
  const configRoot = path.join(homeDir, '.config', 'opencode');
  fs.mkdirSync(configRoot, { recursive: true });
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return {
    homeDir,
    configRoot,
    write(name, content) {
      const file = path.join(configRoot, name);
      fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
      return file;
    },
    read(options = {}) {
      return readOpencodeMcp({ homeDir, ...options });
    },
  };
}

test('JSONC in the existing opencode.json path retains V1 server settings', t => {
  const f = fixture(t);
  f.write('opencode.json', `{
    // Local server for this user.
    "mcp": {
      "docs": { "type": "local", "command": ["node", "server.js",], "enabled": false, },
    },
  }`);
  const records = f.read();
  assert.equal(records.length, 1);
  assert.equal(records[0].name, 'docs');
  assert.equal(records[0].command, 'node');
  assert.deepEqual(records[0].args, ['server.js']);
  assert.equal(records[0].enabled, false);
});

test('V2 pure JSON reads actual servers and disabled flags instead of global option objects', t => {
  const f = fixture(t);
  f.write('opencode.json', {
    mcp: {
      timeout: { startup: 45000 },
      servers: {
        docs: { type: 'local', command: ['node', 'server.js'], disabled: true },
        remote: { type: 'remote', url: 'https://example.invalid/mcp', disabled: false },
      },
    },
  });
  const records = f.read();
  assert.deepEqual(records.map(r => r.name), ['docs', 'remote']);
  assert.equal(records[0].enabled, false);
  assert.equal(records[1].enabled, true);
  assert.equal(records[1].url, 'https://example.invalid/mcp');
});

test('default discovery reads a standalone opencode.jsonc file', t => {
  const f = fixture(t);
  const configPath = f.write('opencode.jsonc', '{ "mcp": { "servers": { "docs": { "type": "local", "command": ["node"], }, }, }, }');
  assert.deepEqual(f.read().map(r => [r.name, r.command, r.source.configPath]), [['docs', 'node', configPath]]);
});

test('JSONC overrides complete V2 server definitions while preserving unrelated JSON entries', t => {
  const f = fixture(t);
  const json = f.write('opencode.json', {
    mcp: { servers: {
      kept: { type: 'local', command: ['node', 'kept.js'] },
      replaced: { type: 'local', command: ['node', 'old.js'], environment: { OLD: 'value' } },
    } },
  });
  const jsonc = f.write('opencode.jsonc', {
    mcp: { servers: {
      replaced: { type: 'remote', url: 'https://example.invalid/new', disabled: true },
      added: { type: 'local', command: ['python', 'new.py'] },
    } },
  });
  const records = f.read();
  assert.deepEqual(records.map(r => r.name), ['kept', 'replaced', 'added']);
  assert.equal(records[0].source.configPath, json);
  assert.equal(records[1].source.configPath, jsonc);
  assert.equal(records[1].command, null);
  assert.deepEqual(records[1].env, {});
  assert.equal(records[1].enabled, false);
  assert.equal(records[2].command, 'python');
});

test('V1 JSONC overrides preserve inherited command and environment settings', t => {
  const f = fixture(t);
  f.write('opencode.json', { mcp: { docs: {
    type: 'local', command: ['node', 'old.js'], environment: { KEEP: 'yes', REPLACE: 'old' },
  } } });
  f.write('opencode.jsonc', { mcp: { docs: {
    command: ['node', 'new.js'], environment: { REPLACE: 'new' }, enabled: false,
  } } });
  const [record] = f.read();
  assert.equal(record.type, 'local');
  assert.deepEqual(record.args, ['new.js']);
  assert.deepEqual(record.env, { KEEP: 'yes', REPLACE: 'new' });
  assert.equal(record.enabled, false);
});

test('comment-like strings and escaped quotes survive JSONC parsing', t => {
  const f = fixture(t);
  const args = ['https://example.invalid/a//b', '/* literal */', 'a"b', 'C:\\tools\\server.js'];
  const content = JSON.stringify({ mcp: { docs: { type: 'local', command: ['node', ...args] } } });
  f.write('opencode.json', `/* header */\r\n${content}\r\n// footer\r\n`);
  assert.deepEqual(f.read()[0].args, args);
});

for (const content of ['{"mcp": {,}}', '{"mcp": {},,}', '{"mcp": {} /* unfinished', 'null', '[]']) {
  test(`invalid JSONC remains rejected: ${content}`, t => {
    const f = fixture(t);
    f.write('opencode.json', content);
    assert.deepEqual(f.read(), []);
  });
}

test('legacy servers literally named servers and timeout remain server entries', t => {
  const f = fixture(t);
  f.write('opencode.json', { mcp: {
    servers: { type: 'local', command: ['node'], enabled: false },
    timeout: { type: 'remote', url: 'https://example.invalid/mcp' },
  } });
  const records = f.read();
  assert.deepEqual(records.map(r => r.name), ['servers', 'timeout']);
  assert.equal(records[0].enabled, false);
  assert.equal(records[1].url, 'https://example.invalid/mcp');
});

test('V2 global-only and empty server tables do not create phantom servers', t => {
  const f = fixture(t);
  for (const mcp of [{ timeout: { startup: 5000 } }, { servers: {}, timeout: { startup: 5000 } }]) {
    f.write('opencode.json', { mcp });
    assert.deepEqual(f.read(), []);
  }
});

test('explicit configPath reads JSONC without adding discovered defaults', t => {
  const f = fixture(t);
  f.write('opencode.json', { mcp: { unexpected: { command: ['wrong'] } } });
  const explicit = path.join(f.homeDir, 'custom.jsonc');
  fs.writeFileSync(explicit, '{ /* explicit */ "mcpServers": { "chosen": { "command": ["node"], }, }, }');
  assert.deepEqual(f.read({ configPath: explicit }).map(r => r.name), ['chosen']);
});

test('legacy config path fallbacks remain available when modern files are absent', t => {
  const f = fixture(t);
  const first = f.write('config.json', { mcpServers: { legacy: { command: ['node'] } } });
  const last = path.join(f.homeDir, '.opencode.json');
  fs.writeFileSync(last, JSON.stringify({ mcp: { older: { command: ['python'] } } }));
  assert.deepEqual(f.read().map(r => r.name), ['legacy']);
  fs.unlinkSync(first);
  assert.deepEqual(f.read().map(r => r.name), ['older']);
});

test('a malformed higher-priority file does not return a partial usable inventory', t => {
  const f = fixture(t);
  f.write('opencode.json', { mcp: { servers: { docs: { command: ['node'] } } } });
  f.write('opencode.jsonc', '{broken');
  assert.deepEqual(f.read(), []);
});

test('real inventory CLI includes V2 JSONC servers without printing credentials or changing config', t => {
  const f = fixture(t);
  const configPath = f.write('opencode.jsonc', `{
    "mcp": { "servers": {
      "docs": { "type": "local", "command": ["node", "server.js"], "environment": { "MCP_API_KEY": "test-inventory-secret" }, },
      "remote": { "type": "remote", "url": "https://example.invalid/mcp", "disabled": true, },
    }, },
  }`);
  const before = fs.readFileSync(configPath);
  const command = path.join(__dirname, '../../scripts/mcp-inventory.js');
  const env = { ...process.env, HOME: f.homeDir, USERPROFILE: f.homeDir, OPENCODE_CONFIG_DIR: f.configRoot };
  for (const args of [['--json'], []]) {
    const result = spawnSync(process.execPath, [command, ...args], { cwd: f.homeDir, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('test-inventory-secret'));
    if (args.length) {
      const inventory = JSON.parse(result.stdout);
      assert.deepEqual(inventory.servers.map(s => s.name), ['docs', 'remote']);
      assert.equal(inventory.aggregates.serverCount, 2);
      assert.equal(inventory.aggregates.serversWithSecrets, 1);
      assert.equal(inventory.servers[1].enabled, false);
    } else {
      assert.match(result.stdout, /docs\s+->\s+stdio:node server\.js/);
      assert.match(result.stdout, /remote.*\(disabled\)/);
    }
  }
  assert.deepEqual(fs.readFileSync(configPath), before);
});
