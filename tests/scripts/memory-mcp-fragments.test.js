'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const serverPath = path.resolve(__dirname, '../../scripts/memory-mcp.mjs');
const serverModule = import(pathToFileURL(serverPath).href);
const ping = (id, params = {}) => ({ jsonrpc: '2.0', id, method: 'ping', params });

async function transport(t) {
  const { runStdioServer } = await serverModule;
  const input = new PassThrough();
  const output = new PassThrough();
  const responses = [];
  let pendingOutput = '';
  output.on('data', chunk => {
    pendingOutput += chunk.toString('utf8');
    let end;
    while ((end = pendingOutput.indexOf('\n')) >= 0) {
      responses.push(JSON.parse(pendingOutput.slice(0, end)));
      pendingOutput = pendingOutput.slice(end + 1);
    }
  });
  t.after(() => { input.destroy(); output.destroy(); });
  runStdioServer({ input, output, serviceOptions: { harness: 'claude' } });
  const waitFor = async count => {
    const deadline = Date.now() + 3000;
    while (responses.length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(responses.length, count, JSON.stringify(responses));
    return responses;
  };
  const initialize = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fragment-test', version: '1.0.0' },
  } };
  input.write(`${[initialize, { jsonrpc: '2.0', method: 'notifications/initialized' }, ping('ready')].map(JSON.stringify).join('\n')}\n`);
  await waitFor(2);
  responses.length = 0;
  return { input, responses, waitFor };
}

function writeFragments(input, bytes, size) {
  for (let start = 0; start < bytes.length; start += size) input.write(bytes.subarray(start, start + size));
}

function sizedPing(size, id = 'sized') {
  const message = ping(id, { _meta: { payload: '' } });
  message.params._meta.payload = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(message)));
  const bytes = Buffer.from(JSON.stringify(message));
  assert.equal(bytes.length, size);
  return bytes;
}

test('real stdio fragments copy a bounded multiple of the message bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-copy-work-'));
  const preload = path.join(root, 'count-copies.cjs');
  // Observe the real stdin callback and real Buffer operations. Acknowledging
  // each chunk prevents the OS from merging the entire fixture into one read.
  fs.writeFileSync(preload, [
    'let copied = 0; let tracking = false;',
    'const concat = Buffer.concat; const copy = Buffer.prototype.copy;',
    'Buffer.concat = function(list, ...args) {',
    '  if (tracking) copied += list.reduce((sum, value) => sum + value.length, 0);',
    '  return concat.call(this, list, ...args);',
    '};',
    'Buffer.prototype.copy = function(...args) {',
    '  const count = copy.apply(this, args); if (tracking) copied += count; return count;',
    '};',
    'const on = process.stdin.on;',
    'process.stdin.on = function(event, callback) {',
    "  if (event !== 'data') return on.call(this, event, callback);",
    '  const result = on.call(this, event, function(chunk) {',
    '    const before = copied; tracking = true;',
    '    try { return callback.call(this, chunk); } finally {',
    '      tracking = false;',
    "      process.stderr.write(JSON.stringify({ bytes: chunk.length, copied: copied - before }) + '\\n');",
    '    }',
    '  });',
    "  process.stderr.write('READY\\n'); return result;",
    '};',
  ].join('\n'));
  const child = spawn(process.execPath, ['--require', preload, serverPath], {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, ECC_MEMORY_HARNESS: 'claude' },
    stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  let stdout = '';
  let stderr = '';
  let pendingReport = '';
  let ready = false;
  const reports = [];
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    pendingReport += chunk;
    let end;
    while ((end = pendingReport.indexOf('\n')) >= 0) {
      const line = pendingReport.slice(0, end);
      pendingReport = pendingReport.slice(end + 1);
      if (line === 'READY') ready = true;
      else if (line.startsWith('{')) reports.push(JSON.parse(line));
    }
  });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const waitFor = async predicate => {
    const deadline = Date.now() + 5000;
    while (!predicate() && child.exitCode === null && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(predicate(), stderr);
  };
  const send = async bytes => {
    const count = reports.length;
    child.stdin.write(bytes);
    await waitFor(() => reports.length > count);
  };
  await waitFor(() => ready);
  const initialize = { jsonrpc: '2.0', id: 'init', method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'copy-test', version: '1.0.0' },
  } };
  await send(`${JSON.stringify(initialize)}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const measurementStart = reports.length;
  const bytes = sizedPing(256 * 1024);
  for (let start = 0; start < bytes.length; start += 1024) await send(bytes.subarray(start, start + 1024));
  await send('\n');
  child.stdin.end();
  const result = await completed;
  assert.equal(result.code, 0, stderr);
  assert.equal(result.signal, null);
  const responses = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].id, 'init');
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 'sized', result: {} });
  const measured = reports.slice(measurementStart);
  assert.ok(measured.length >= 256, 'the request must arrive through multiple real stdin chunks');
  assert.equal(measured.reduce((sum, record) => sum + record.bytes, 0), bytes.length + 1);
  const copiedBytes = measured.reduce((sum, record) => sum + record.copied, 0);
  assert.ok(copiedBytes <= bytes.length * 4, `${copiedBytes} copied bytes for a ${bytes.length}-byte frame`);
  t.diagnostic(`${measured.length} stdin chunks; ${copiedBytes} copied bytes for a ${bytes.length}-byte frame`);
});

test('one-byte fragments preserve split multibyte request IDs and CRLF framing', async t => {
  const { input, waitFor } = await transport(t);
  const id = '请求-\u{1F642}-e\u0301';
  writeFragments(input, Buffer.from(`${JSON.stringify(ping(id))}\r\n`), 1);
  assert.deepEqual(await waitFor(1), [{ jsonrpc: '2.0', id, result: {} }]);
});

test('multiple frames and a trailing partial frame stay separate across arbitrary chunks', async t => {
  const { input, waitFor } = await transport(t);
  const bytes = Buffer.from(`${[ping('one'), ping('two'), ping('three')].map(JSON.stringify).join('\n')}\n`);
  input.write(bytes.subarray(0, bytes.length - 3));
  writeFragments(input, bytes.subarray(bytes.length - 3), 1);
  assert.deepEqual((await waitFor(3)).map(response => response.id), ['one', 'two', 'three']);
});

test('EOF processes an unterminated fragmented frame without unused buffer bytes', async t => {
  const { input, waitFor } = await transport(t);
  writeFragments(input, Buffer.from(JSON.stringify(ping('eof'))), 7);
  input.end();
  assert.deepEqual(await waitFor(1), [{ jsonrpc: '2.0', id: 'eof', result: {} }]);
});

test('a frame exactly at the byte limit succeeds after many growth steps', async t => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, waitFor } = await transport(t);
  writeFragments(input, sizedPing(MAX_MESSAGE_BYTES), 8191);
  input.write('\n');
  assert.deepEqual(await waitFor(1), [{ jsonrpc: '2.0', id: 'sized', result: {} }]);
});

test('an oversized fragmented frame reports once and recovers at the next newline', async t => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, waitFor } = await transport(t);
  writeFragments(input, sizedPing(MAX_MESSAGE_BYTES + 1), 8191);
  input.write(`discarded bytes\n${JSON.stringify(ping('recovered'))}\n`);
  const responses = await waitFor(2);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error?.code, -32700);
  assert.match(responses[0].error.message, /too large/);
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 'recovered', result: {} });
});

test('EOF after an oversized frame does not reprocess its discarded prefix', async t => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, waitFor } = await transport(t);
  writeFragments(input, sizedPing(MAX_MESSAGE_BYTES + 1), 8191);
  input.end();
  const responses = await waitFor(1);
  assert.equal(responses[0].error?.code, -32700);
  assert.match(responses[0].error.message, /too large/);
});

test('empty lines remain parse errors and do not contaminate the next frame', async t => {
  const { input, waitFor } = await transport(t);
  input.write('\n\r\n');
  writeFragments(input, Buffer.from(`${JSON.stringify(ping('after-empty'))}\n`), 3);
  const responses = await waitFor(3);
  assert.deepEqual(responses.slice(0, 2).map(response => response.error?.code), [-32700, -32700]);
  assert.deepEqual(responses[2], { jsonrpc: '2.0', id: 'after-empty', result: {} });
});

test('an interrupted input stream reports its error without processing a partial frame', async t => {
  const { input, waitFor } = await transport(t);
  input.write('{"jsonrpc":"2.0","id":"unfinished"');
  input.destroy(new Error('fixture stream interrupted'));
  const responses = await waitFor(1);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error?.code, -32603);
  assert.match(responses[0].error.message, /input stream failed/);
});
