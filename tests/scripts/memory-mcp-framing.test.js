'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const serverModule = import(pathToFileURL(path.join(__dirname, '../../scripts/memory-mcp.mjs')).href);

function request(id, padding = '') {
  return { jsonrpc: '2.0', id, method: 'ping', params: { _meta: { padding } } };
}

function sizedRequest(id, bytes) {
  const message = request(id);
  message.params._meta.padding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(message)));
  return Buffer.from(JSON.stringify(message));
}

function writeFragments(input, buffer, size) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    input.write(buffer.subarray(offset, offset + size));
  }
}

async function createServer(context) {
  const { runStdioServer } = await serverModule;
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  const waiters = new Set();
  let pending = '';
  output.setEncoding('utf8');
  output.on('data', chunk => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(pending.slice(0, end)));
      pending = pending.slice(end + 1);
      for (const waiter of waiters) {
        if (messages.length >= waiter.count) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve(messages);
        }
      }
    }
  });
  context.after(() => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    input.destroy();
    output.destroy();
  });
  runStdioServer({ input, output, serviceOptions: { harness: 'claude' } });
  const receive = count => {
    if (messages.length >= count) return Promise.resolve(messages);
    return new Promise((resolve, reject) => {
      const waiter = { count, resolve };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Expected ${count} responses, received ${messages.length}`));
      }, 3000);
      waiters.add(waiter);
    });
  };
  input.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'framing-tests', version: '1.0.0' },
    },
  })}\n`);
  assert.equal((await receive(1))[0].result.protocolVersion, '2025-11-25');
  messages.length = 0;
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return { input, output, messages, receive };
}

// Count actual Buffer storage requested while delivering the input, including
// nested Buffer factories only once. This is deterministic; elapsed time is not
// a test gate, and the bound does not depend on a particular buffering strategy.
function allocatedBufferBytes(callback) {
  const originals = new Map();
  let depth = 0;
  let bytes = 0;
  try {
    for (const name of ['alloc', 'allocUnsafe', 'allocUnsafeSlow', 'from', 'concat']) {
      const original = Buffer[name];
      originals.set(name, original);
      Buffer[name] = function (...args) {
        depth += 1;
        try {
          const result = original.apply(Buffer, args);
          if (depth === 1) bytes += result.length;
          return result;
        } finally {
          depth -= 1;
        }
      };
    }
    callback();
  } finally {
    for (const [name, original] of originals) Buffer[name] = original;
  }
  return bytes;
}

test('fragmented requests use storage allocation proportional to their byte length', async context => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, receive } = await createServer(context);
  const frame = Buffer.concat([sizedRequest('bounded', MAX_MESSAGE_BYTES), Buffer.from('\n')]);
  const bytes = allocatedBufferBytes(() => writeFragments(input, frame, 1024));
  assert.deepEqual((await receive(1))[0], { jsonrpc: '2.0', id: 'bounded', result: {} });
  assert.ok(bytes <= 8 * frame.length, `Allocated ${bytes} bytes for a ${frame.length}-byte frame`);
});

test('one-byte fragments preserve UTF-8 IDs and split CRLF terminators', async context => {
  const { input, receive } = await createServer(context);
  const id = '边界-\u{1f9ea}';
  writeFragments(input, Buffer.from(`${JSON.stringify(request(id))}\r\n`), 1);
  assert.deepEqual((await receive(1))[0], { jsonrpc: '2.0', id, result: {} });
});

test('completed frames stay independent while later fragments reuse receiver storage', async context => {
  const { input, receive } = await createServer(context);
  const ids = Array.from({ length: 16 }, (_, index) => `request-${index}`);
  const wire = ids.map((id, index) => `${JSON.stringify(request(id, 'x'.repeat(index * 257)))}\n`).join('');
  writeFragments(input, Buffer.from(wire), 37);
  assert.deepEqual(await receive(ids.length), ids.map(id => ({ jsonrpc: '2.0', id, result: {} })));
});

test('exactly the message limit is accepted and an oversized line recovers at its newline', async context => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, receive } = await createServer(context);
  writeFragments(input, sizedRequest('at-limit', MAX_MESSAGE_BYTES), 8191);
  input.write('\n');
  writeFragments(input, sizedRequest('over-limit', MAX_MESSAGE_BYTES + 1), 4093);
  input.write(`\n${JSON.stringify(request('after-limit'))}\n`);
  const messages = await receive(3);
  assert.deepEqual(messages[0], { jsonrpc: '2.0', id: 'at-limit', result: {} });
  assert.equal(messages[1].error.code, -32700);
  assert.match(messages[1].error.message, /too large/);
  assert.deepEqual(messages[2], { jsonrpc: '2.0', id: 'after-limit', result: {} });
});

test('the CR byte in CRLF continues to count toward the message limit', async context => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, receive } = await createServer(context);
  writeFragments(input, sizedRequest('cr-at-limit', MAX_MESSAGE_BYTES - 1), 4093);
  input.write('\r');
  input.write('\n');
  writeFragments(input, sizedRequest('cr-over-limit', MAX_MESSAGE_BYTES), 4093);
  input.write('\r');
  input.write('\n');
  const messages = await receive(2);
  assert.deepEqual(messages[0], { jsonrpc: '2.0', id: 'cr-at-limit', result: {} });
  assert.equal(messages[1].error.code, -32700);
  assert.match(messages[1].error.message, /too large/);
});

test('a fragmented final request is processed when input ends without a newline', async context => {
  const { input, receive } = await createServer(context);
  writeFragments(input, Buffer.from(JSON.stringify(request('at-eof', 'é'.repeat(4096)))), 43);
  input.end();
  assert.deepEqual((await receive(1))[0], { jsonrpc: '2.0', id: 'at-eof', result: {} });
});

test('an oversized unterminated line emits one error and no partial EOF frame', async context => {
  const { MAX_MESSAGE_BYTES } = await serverModule;
  const { input, receive, messages } = await createServer(context);
  writeFragments(input, sizedRequest('too-large-at-eof', MAX_MESSAGE_BYTES + 5000), 4093);
  input.end();
  await receive(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].error.code, -32700);
});

test('sender-owned fragment storage can be reused immediately after each write', async context => {
  const { input, receive } = await createServer(context);
  const wire = Buffer.from(`${JSON.stringify(request('reused-input', '\u{1f9ea}'.repeat(500)))}\n`);
  const fragment = Buffer.alloc(1);
  for (const byte of wire) {
    fragment[0] = byte;
    input.write(fragment);
    fragment[0] = 0;
  }
  assert.deepEqual((await receive(1))[0], { jsonrpc: '2.0', id: 'reused-input', result: {} });
});

test('blank and malformed lines report parse errors without retaining previous frame bytes', async context => {
  const { input, receive } = await createServer(context);
  writeFragments(input, Buffer.from(`${JSON.stringify(request('first', 'x'.repeat(9000)))}\n\n{invalid}\n${JSON.stringify(request('last'))}\n`), 61);
  const messages = await receive(4);
  assert.deepEqual(messages[0], { jsonrpc: '2.0', id: 'first', result: {} });
  assert.equal(messages[1].error.code, -32700);
  assert.equal(messages[2].error.code, -32700);
  assert.deepEqual(messages[3], { jsonrpc: '2.0', id: 'last', result: {} });
});
