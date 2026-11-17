'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createControlPaneServer } = require('../../scripts/lib/control-pane/server');
const { createStateStore } = require('../../scripts/lib/state-store');

const BODY_LIMIT = 1024 * 1024;
const COPY_ONLY = '/api/actions/open-dashboard';

async function startApp(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-request-limit-'));
  const stateDbPath = path.join(root, 'state.db');
  let app = null;
  t.after(async () => {
    if (app && app.server.listening) {
      app.server.closeAllConnections();
      await app.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = await createStateStore({ dbPath: stateDbPath });
  try {
    store.upsertWorkItem({ id: 'card', source: 'manual', title: 'Fixture', status: 'open', owner: null, metadata: {} });
  } finally { store.close(); }
  app = createControlPaneServer({
    host: '127.0.0.1', port: 0, repoRoot: root, cwd: root,
    stateDbPath, env: { HOME: root }, ...options,
  });
  await app.listen();
  return { app, stateDbPath };
}

function request(app, pathname, { chunks = [], headers = {}, end = true, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${app.url}${pathname}`, {
      method, agent: false, headers: { 'Content-Type': 'application/json', ...headers },
    }, res => {
      const received = [];
      res.on('data', chunk => received.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        clearTimeout(timer);
        req.destroy();
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(received).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP fixture timed out waiting for a response')), 3000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.flushHeaders();
    for (const chunk of chunks) req.write(chunk);
    if (end) req.end();
  });
}

async function assertHealthy(app) {
  const response = await request(app, '/api/health', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
}

test('rejects an oversized declared body before waiting for body bytes', async t => {
  const { app } = await startApp(t);
  const result = await request(app, COPY_ONLY, { headers: { 'Content-Length': String(BODY_LIMIT + 1) }, end: false });
  assert.equal(result.status, 413);
  assert.equal(result.headers.connection, 'close');
  assert.equal(result.body.ok, false);
  await assertHealthy(app);
});

test('rejects a chunked upload as soon as cumulative bytes exceed the limit', async t => {
  const { app } = await startApp(t);
  const result = await request(app, COPY_ONLY, {
    chunks: [Buffer.alloc(BODY_LIMIT / 2, 32), Buffer.alloc(BODY_LIMIT / 2, 32), Buffer.from('x')],
    end: false,
  });
  assert.equal(result.status, 413, 'an oversized unfinished upload must not wait for EOF');
  assert.equal(result.headers.connection, 'close');
  await assertHealthy(app);
});

test('counts UTF-8 bytes rather than decoded characters', async t => {
  const { app } = await startApp(t);
  const body = JSON.stringify({ padding: 'é'.repeat(600000) });
  assert.ok(body.length < BODY_LIMIT);
  assert.ok(Buffer.byteLength(body) > BODY_LIMIT);
  const result = await request(app, COPY_ONLY, { chunks: [body] });
  assert.equal(result.status, 413);
});

test('accepts valid JSON at and below the byte limit', async t => {
  const { app } = await startApp(t);
  for (const size of [BODY_LIMIT - 1, BODY_LIMIT]) {
    const body = Buffer.from('{}' + ' '.repeat(size - 2));
    const result = await request(app, COPY_ONLY, { chunks: [body.subarray(0, 17), body.subarray(17)] });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /copy-only/);
  }
});

test('preserves empty and whitespace-only request handling', async t => {
  const { app } = await startApp(t);
  for (const chunks of [[], [' \r\n\t ']]) {
    const result = await request(app, COPY_ONLY, { chunks });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /copy-only/);
  }
});

test('preserves malformed JSON handling below the limit', async t => {
  const { app } = await startApp(t);
  const result = await request(app, COPY_ONLY, { chunks: ['{"query":'] });
  assert.equal(result.status, 500);
  assert.equal(result.body.ok, false);
  await assertHealthy(app);
});

for (const [action, values] of [['claim', { owner: 'alice' }], ['move', { lane: 'done' }]]) {
  test(`an oversized ${action} body cannot mutate the work-item database`, async t => {
    const { app, stateDbPath } = await startApp(t);
    const before = fs.readFileSync(stateDbPath);
    const body = JSON.stringify({ ...values, padding: 'x'.repeat(BODY_LIMIT) });
    const result = await request(app, `/api/work-items/card/${action}`, { chunks: [body] });
    assert.equal(result.status, 413);
    assert.deepEqual(fs.readFileSync(stateDbPath), before);
    await assertHealthy(app);
  });
}

test('small work-item claim and move requests still succeed', async t => {
  const { app } = await startApp(t);
  const claim = await request(app, '/api/work-items/card/claim', { chunks: [JSON.stringify({ owner: 'alice', as: 'human' })] });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.item.owner, 'alice');
  const move = await request(app, '/api/work-items/card/move', { chunks: [JSON.stringify({ lane: 'blocked' })] });
  assert.equal(move.status, 200);
  assert.equal(move.body.item.status, 'blocked');
});

test('host, origin, and read-only gates still run before request parsing', async t => {
  const { app } = await startApp(t, { allowActions: false });
  for (const [headers, expected] of [[{ Host: 'example.invalid' }, 421], [{ Origin: 'https://example.invalid' }, 403], [{}, 403]]) {
    const result = await request(app, COPY_ONLY, {
      headers: { 'Content-Length': String(BODY_LIMIT + 1), ...headers }, end: false,
    });
    assert.equal(result.status, expected);
  }
});
