'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const serverPath = path.resolve(__dirname, '../../scripts/memory-mcp.mjs');
const serverModule = import(pathToFileURL(serverPath).href);
const initialize = (id = 'init', protocolVersion = '2025-11-25') => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'handshake-test', version: '1.0.0' } },
});
const ping = params => ({ jsonrpc: '2.0', id: 'ping', method: 'ping', ...(params === undefined ? {} : { params }) });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };

async function pendingService() {
  const { createMemoryMcpService } = await serverModule;
  const service = createMemoryMcpService({ harness: 'claude' });
  assert.equal((await service.handle(initialize())).error, undefined);
  return service;
}

for (const [label, params] of [
  ['omitted parameters', undefined],
  ['empty parameters', {}],
  ['reserved metadata', { _meta: { progressToken: 'handshake' } }],
]) {
  test(`answers a ping with ${label} before the initialized notification`, async () => {
    const service = await pendingService();
    assert.deepEqual(await service.handle(ping(params)), { jsonrpc: '2.0', id: 'ping', result: {} });
  });
}

test('handshake pings use the same parameter validation as operational pings', async () => {
  const service = await pendingService();
  for (const params of [{ _meta: null }, { _meta: [] }, { _meta: 'invalid' }, { unexpected: true }]) {
    const response = await service.handle(ping(params));
    assert.equal(response.id, 'ping');
    assert.equal(response.error?.code, -32602);
  }
});

test('pings do not finish initialization or permit tools before the notification', async () => {
  const service = await pendingService();
  assert.deepEqual((await service.handle(ping())).result, {});
  for (const method of ['tools/list', 'tools/call']) {
    assert.equal((await service.handle({ jsonrpc: '2.0', id: method, method })).error?.code, -32002);
  }
  assert.equal(await service.handle(initialized), null);
  const listed = await service.handle({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' });
  assert.ok(listed.result.tools.some(tool => tool.name === 'memory_search'));
  assert.deepEqual((await service.handle(ping())).result, {});
});

test('every supported protocol version permits a ping in its initialization handshake', async () => {
  const { createMemoryMcpService, SUPPORTED_PROTOCOL_VERSIONS } = await serverModule;
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const service = createMemoryMcpService({ harness: 'claude' });
    assert.equal((await service.handle(initialize('init', version))).result.protocolVersion, version);
    assert.deepEqual((await service.handle(ping())).result, {}, version);
  }
});

test('a valid initialize request still starts the session before pings are accepted', async () => {
  const { createMemoryMcpService } = await serverModule;
  const service = createMemoryMcpService({ harness: 'claude' });
  assert.equal((await service.handle(ping())).error?.code, -32002);
  assert.equal(await service.handle(initialized), null);
  assert.equal((await service.handle(ping())).error?.code, -32002);
  const invalid = { ...initialize(), params: {} };
  assert.equal((await service.handle(invalid)).error?.code, -32602);
  assert.equal((await service.handle(ping())).error?.code, -32002);
});

test('invalid JSON-RPC envelopes remain errors during initialization', async () => {
  const service = await pendingService();
  for (const message of [ping([]), ping(null), { ...ping(), id: null }, { ...ping(), jsonrpc: '1.0' }]) {
    const response = await service.handle(message);
    assert.equal(response.id, null);
    assert.equal(response.error?.code, -32600);
  }
});

test('duplicate initialize requests remain rejected without enabling tools', async () => {
  const service = await pendingService();
  assert.equal((await service.handle(initialize('again'))).error?.code, -32600);
  assert.equal((await service.handle({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' })).error?.code, -32002);
});

test('the stdio server preserves the complete handshake and ping response order', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-handshake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const messages = [initialize(), ping({ _meta: {} }),
    { jsonrpc: '2.0', id: 'blocked', method: 'tools/list' }, initialized,
    { ...ping(), id: 'ready-ping' }, { jsonrpc: '2.0', id: 'ready-tools', method: 'tools/list' }];
  const result = spawnSync(process.execPath, [serverPath], {
    input: `${messages.map(message => JSON.stringify(message)).join('\n')}\n`,
    cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HOME: root, USERPROFILE: root, ECC_MEMORY_HARNESS: 'claude' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(responses.map(response => response.id), ['init', 'ping', 'blocked', 'ready-ping', 'ready-tools']);
  assert.deepEqual(responses[1].result, {});
  assert.equal(responses[2].error?.code, -32002);
  assert.deepEqual(responses[3].result, {});
  assert.ok(responses[4].result.tools.some(tool => tool.name === 'memory_search'));
});
