'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const capsule = require('../../../scripts/lib/eval-harness/capsule');
const receipts = require('../../../scripts/lib/eval-harness/receipt');
const { test, tempDir, cleanup, finish } = require('./helpers');

function signedCapsule() {
  const dir = tempDir('verifier-result');
  const store = capsule.Capsule.create(dir, { run_id: 'verify-run', capsule_id: 'verify-cap', task_family: 'verifier' });
  store.append('attempt', 'run', { status: 'pass' });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const receipt = receipts.buildReceipt(dir, {
    signer: hash => crypto.sign(null, Buffer.from(hash, 'hex'), privateKey).toString('base64'),
  });
  const verifier = (hash, signature) => crypto.verify(null, Buffer.from(hash, 'hex'), publicKey, Buffer.from(signature, 'base64'));
  return { dir, receipt, verifier };
}

test('only an explicit boolean success accepts a detached signature', () => {
  const { dir, receipt, verifier } = signedCapsule();
  try {
    assert.strictEqual(receipts.verifyReceipt(receipt, dir, { verifier }).ok, true);
    for (const result of [false, null, undefined, 0, 1, '', 'false', {}, [], new Boolean(false)]) {
      const checked = receipts.verifyReceipt(receipt, dir, { verifier: () => result });
      assert.strictEqual(checked.ok, false, `accepted ${String(result)}`);
      assert.strictEqual(checked.check, 'signature');
    }
  } finally { cleanup(dir); }
});

test('a Promise resolving false cannot approve a real wrong-key signature', () => {
  const { dir, receipt } = signedCapsule();
  try {
    const wrongKey = crypto.generateKeyPairSync('ed25519').publicKey;
    const checked = receipts.verifyReceipt(receipt, dir, {
      verifier: async (hash, signature) => crypto.verify(null, Buffer.from(hash, 'hex'), wrongKey, Buffer.from(signature, 'base64')),
    });
    assert.strictEqual(checked.ok, false);
    assert.strictEqual(checked.check, 'signature');
    assert.strictEqual(typeof checked.then, 'undefined');
  } finally { cleanup(dir); }
});

test('even a pending or successful asynchronous verifier is not synchronous approval', () => {
  const { dir, receipt } = signedCapsule();
  try {
    for (const result of [Promise.resolve(true), new Promise(() => {}), { then(resolve) { resolve(true); } }]) {
      assert.strictEqual(receipts.verifyReceipt(receipt, dir, { verifier: () => result }).check, 'signature');
    }
  } finally { cleanup(dir); }
});

test('verifier exceptions return a signature failure without exposing diagnostics', () => {
  const { dir, receipt } = signedCapsule();
  try {
    for (const verifier of [
      () => { throw new Error('private verifier diagnostic'); },
      () => Object.defineProperty({}, 'then', { get() { throw new Error('private getter diagnostic'); } }),
    ]) {
      const result = receipts.verifyReceipt(receipt, dir, { verifier });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.check, 'signature');
      assert.ok(!result.reason.includes('private'));
    }
  } finally { cleanup(dir); }
});

test('rejected async verifiers are refused without an unhandled rejection in a real process', () => {
  const { dir, receipt } = signedCapsule();
  try {
    const script = `
      const { verifyReceipt } = require(${JSON.stringify(require.resolve('../../../scripts/lib/eval-harness/receipt'))});
      const result = verifyReceipt(${JSON.stringify(receipt)}, ${JSON.stringify(dir)}, {
        verifier: async () => { throw new Error('private async diagnostic'); }
      });
      setImmediate(() => process.stdout.write(JSON.stringify(result)));
    `;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', script], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(JSON.parse(child.stdout).check, 'signature');
    assert.strictEqual(child.stderr, '');
  } finally { cleanup(dir); }
});

test('valid signatures still verify an exported bundle without changing its bytes', () => {
  const { dir, receipt, verifier } = signedCapsule();
  const out = tempDir('verifier-bundle');
  try {
    capsule.exportBundle(dir, out);
    const snapshot = () => fs.readdirSync(out).sort().map(name => [name, fs.readFileSync(path.join(out, name), 'hex')]);
    const before = snapshot();
    assert.strictEqual(receipts.verifyReceipt(receipt, out, { verifier }).ok, true);
    assert.strictEqual(receipts.verifyReceipt(receipt, out, { verifier: () => ({ ok: false }) }).check, 'signature');
    assert.deepStrictEqual(snapshot(), before);
  } finally { cleanup(dir); cleanup(out); }
});

test('unsigned and no-verifier checks retain their existing contracts', () => {
  const { dir, receipt, verifier } = signedCapsule();
  try {
    assert.strictEqual(receipts.verifyReceipt(receipt, dir).ok, true);
    const unsigned = receipts.buildReceipt(dir);
    assert.strictEqual(receipts.verifyReceipt(unsigned, dir).ok, true);
    assert.strictEqual(receipts.verifyReceipt(unsigned, dir, { verifier }).check, 'signature');
    const altered = { ...receipt, capsule_root: 'f'.repeat(64) };
    let calls = 0;
    assert.strictEqual(receipts.verifyReceipt(altered, dir, { verifier: () => { calls += 1; return true; } }).check, 'receipt_hash');
    assert.strictEqual(calls, 0);
  } finally { cleanup(dir); }
});

test('a method verifier retains its options receiver and is called once', () => {
  const { dir, receipt, verifier } = signedCapsule();
  try {
    const options = {
      verify: verifier,
      calls: 0,
      verifier(hash, signature) {
        this.calls += 1;
        return this.verify(hash, signature);
      },
    };
    assert.strictEqual(receipts.verifyReceipt(receipt, dir, options).ok, true);
    assert.strictEqual(options.calls, 1);
  } finally { cleanup(dir); }
});

finish('eval-harness receipt verifier result');
