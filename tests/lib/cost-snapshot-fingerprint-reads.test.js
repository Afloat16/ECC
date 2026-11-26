'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { appendSessionCostRow, getCostSnapshotPath, refreshSessionCostSnapshot } = require('../../scripts/lib/session-cost-snapshot');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cost-fingerprint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = { session_id: 'selected', timestamp: '2026-11-26T00:00:00Z',
    input_tokens: 100, output_tokens: 50, estimated_cost_usd: 1 };
  const content = `${JSON.stringify({ ...row, session_id: 'other' })}\n`.repeat(40)
    + `${JSON.stringify(row)}\n`;
  fs.writeFileSync(path.join(dir, 'costs.jsonl'), content);
  return { dir, row };
}

function fragmentedFingerprints(fn) {
  const original = fs.readSync;
  let shortReads = 0;
  fs.readSync = function (fd, buffer, offset, length, position) {
    const requested = buffer.length <= 256 ? Math.min(length, 7) : length;
    if (requested < length) shortReads += 1;
    return original.call(this, fd, buffer, offset, requested, position);
  };
  try { return { result: fn(), shortReads }; } finally { fs.readSync = original; }
}

test('short fingerprint reads do not invalidate an unchanged cached cost log', t => {
  const { dir, row } = fixture(t);
  refreshSessionCostSnapshot(dir, 'selected');
  const { result, shortReads } = fragmentedFingerprints(() => refreshSessionCostSnapshot(dir, 'selected'));
  assert.ok(shortReads > 0);
  assert.deepEqual(result.row, row);
  assert.equal(result.scannedBytes, 0);
});

test('snapshots published under short reads remain reusable by ordinary readers', t => {
  const { dir, row } = fixture(t);
  const { result } = fragmentedFingerprints(() => refreshSessionCostSnapshot(dir, 'selected'));
  assert.equal(result.snapshotError, null);
  assert.deepEqual(result.row, row);
  assert.equal(refreshSessionCostSnapshot(dir, 'selected').scannedBytes, 0);
});

test('short reads preserve delta-only scanning after another session appends', t => {
  const { dir, row } = fixture(t);
  refreshSessionCostSnapshot(dir, 'selected');
  const appended = JSON.stringify({ ...row, session_id: 'other', estimated_cost_usd: 2 }) + '\n';
  fs.appendFileSync(path.join(dir, 'costs.jsonl'), appended);
  const { result } = fragmentedFingerprints(() => refreshSessionCostSnapshot(dir, 'selected'));
  assert.deepEqual(result.row, row);
  assert.equal(result.scannedBytes, Buffer.byteLength(appended));
});

test('append publishes the same complete fingerprint as an ordinary read', t => {
  const { dir, row } = fixture(t);
  refreshSessionCostSnapshot(dir, 'selected');
  const newer = { ...row, input_tokens: 200, output_tokens: 100, estimated_cost_usd: 2 };
  assert.equal(fragmentedFingerprints(() => appendSessionCostRow(dir, 'selected', newer)).result, true);
  const next = refreshSessionCostSnapshot(dir, 'selected');
  assert.deepEqual(next.row, newer);
  assert.equal(next.scannedBytes, 0);
});

test('premature fingerprint EOF never publishes a zero-padded cache signature', t => {
  const { dir } = fixture(t);
  const original = fs.readSync;
  fs.readSync = function (fd, buffer, offset, length, position) {
    if (buffer.length <= 256) return 0;
    return original.call(this, fd, buffer, offset, length, position);
  };
  let result;
  try { result = refreshSessionCostSnapshot(dir, 'selected'); } finally { fs.readSync = original; }
  assert.ok(result.snapshotError);
  assert.equal(fs.existsSync(getCostSnapshotPath(dir, 'selected')), false);
});

test('ordinary complete reads retain the existing cache-hit behavior', t => {
  const { dir, row } = fixture(t);
  assert.deepEqual(refreshSessionCostSnapshot(dir, 'selected').row, row);
  const cached = refreshSessionCostSnapshot(dir, 'selected');
  assert.deepEqual(cached.row, row);
  assert.equal(cached.scannedBytes, 0);
});
