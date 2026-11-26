'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FixtureStore, createReplayer } = require('../../../scripts/lib/eval-harness/replay');
const { test, tempDir, cleanup, finish } = require('./helpers');

function declaration(impl, effectClass = 'SE0') {
  return { effect_class: effectClass, determinism: 'deterministic', impl };
}

test('recording enforces the validated effect class after caller declaration mutation', () => {
  const dir = tempDir('declared-record');
  try {
    const store = new FixtureStore(path.join(dir, 'fixtures'));
    const marker = path.join(dir, 'unexpected-call');
    for (const replacement of [undefined, null, '', 'invalid', 'SE0']) {
      const tool = declaration(() => { fs.writeFileSync(marker, 'called'); return 'live'; }, 'SE3');
      const recorder = createReplayer({ publish: tool }, { mode: 'record', store });
      tool.effect_class = replacement;
      assert.throws(() => recorder.call('publish'), { code: 'tool.effect_forbidden' });
      assert.ok(!fs.existsSync(marker));
      assert.strictEqual(recorder.calls[0].status, 'refused');
      assert.deepStrictEqual(fs.readdirSync(store.dir), []);
    }
  } finally { cleanup(dir); }
});

test('replay cannot reclassify a forbidden tool after a fixture has been supplied', () => {
  const dir = tempDir('declared-replay');
  try {
    const store = new FixtureStore(dir);
    const tool = declaration(() => { throw new Error('live implementation must not run'); }, 'SE3');
    const record = store.put('publish', {}, { published: true });
    const before = fs.readFileSync(store.pathFor(record.key));
    const replayer = createReplayer({ publish: tool }, { store, maxEffectClass: 'SE4' });
    tool.effect_class = 'SE0';
    assert.throws(() => replayer.call('publish'), { code: 'tool.effect_forbidden' });
    assert.deepStrictEqual(fs.readFileSync(store.pathFor(record.key)), before);
    assert.strictEqual(replayer.calls[0].status, 'refused');
  } finally { cleanup(dir); }
});

test('inherited and later-added tool names cannot invoke unvalidated implementations', () => {
  const dir = tempDir('declared-names');
  try {
    const store = new FixtureStore(dir);
    let liveCalls = 0;
    const hidden = declaration(() => { liveCalls += 1; return 'unexpected'; });
    const tools = Object.create({ inherited: hidden });
    tools.visible = declaration(() => 'visible');
    const recorder = createReplayer(tools, { mode: 'record', store });
    tools.late = hidden;
    for (const name of ['inherited', 'late', 'constructor', '__proto__', 'toString']) {
      assert.throws(() => recorder.call(name), { code: 'tool.unknown' });
    }
    assert.strictEqual(liveCalls, 0);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.deepStrictEqual(recorder.calls, []);
  } finally { cleanup(dir); }
});

test('replacing or deleting a caller entry preserves its declared implementation and receiver', () => {
  const dir = tempDir('declared-implementation');
  try {
    const store = new FixtureStore(dir);
    const original = {
      effect_class: 'SE0', determinism: 'deterministic', count: 0,
      impl(args) { this.count += 1; return { count: this.count, value: args.value }; },
    };
    const tools = { read: original };
    const recorder = createReplayer(tools, { mode: 'record', store });
    original.impl = () => { throw new Error('replacement implementation ran'); };
    tools.read = declaration(() => 'replacement');
    assert.deepStrictEqual(recorder.call('read', { value: 'a' }), { count: 1, value: 'a' });
    delete tools.read;
    assert.deepStrictEqual(recorder.call('read', { value: 'b' }), { count: 2, value: 'b' });
    assert.strictEqual(original.count, 2);
    assert.deepStrictEqual(store.get('read', { value: 'b' }).response, { count: 2, value: 'b' });
  } finally { cleanup(dir); }
});

test('policy accessors are captured once before validation and cannot change during call', () => {
  const dir = tempDir('declared-accessor');
  try {
    const store = new FixtureStore(dir);
    let reads = 0;
    let liveCalls = 0;
    const tools = { write: {
      get effect_class() { reads += 1; return reads === 1 ? 'SE3' : 'SE0'; },
      determinism: 'deterministic',
      impl() { liveCalls += 1; return 'unexpected'; },
    } };
    const recorder = createReplayer(tools, { mode: 'record', store });
    assert.throws(() => recorder.call('write'), { code: 'tool.effect_forbidden' });
    assert.strictEqual(reads, 1);
    assert.strictEqual(liveCalls, 0);
  } finally { cleanup(dir); }
});

test('own prototype-like names and frozen caller declarations remain supported', () => {
  const dir = tempDir('declared-own-names');
  try {
    const store = new FixtureStore(dir);
    const tools = Object.create(null);
    for (const name of ['__proto__', 'constructor', 'toString']) {
      tools[name] = Object.freeze(declaration(() => ({ name })));
    }
    Object.freeze(tools);
    const recorder = createReplayer(tools, { mode: 'record', store });
    const replayer = createReplayer(tools, { mode: 'replay', store });
    for (const name of Object.keys(tools)) {
      assert.deepStrictEqual(recorder.call(name), { name });
      assert.deepStrictEqual(replayer.call(name), { name });
      assert.ok(Object.isFrozen(tools[name]));
    }
    assert.strictEqual(recorder.calls.length, 3);
    assert.strictEqual(replayer.calls.length, 3);
  } finally { cleanup(dir); }
});

test('a replay-only declaration still needs no live implementation', () => {
  const dir = tempDir('declared-fixture-only');
  try {
    const store = new FixtureStore(dir);
    const tools = { read: { effect_class: 'SE0', determinism: 'nondeterministic' } };
    store.put('read', {}, { cached: true });
    const before = JSON.stringify(tools);
    assert.deepStrictEqual(createReplayer(tools, { store }).call('read'), { cached: true });
    assert.strictEqual(JSON.stringify(tools), before);
  } finally { cleanup(dir); }
});

finish('eval-harness replay declarations');
