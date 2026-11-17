'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { getCostSnapshotPath } = require('../../scripts/lib/session-cost-snapshot');

const hook = path.resolve(__dirname, '../../scripts/hooks/cost-tracker.js');
const transcriptCost = 10.5; // 1M input at $3 and 0.5M output at $15.

function recordedCost(t, cacheValue) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-harness-types-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const temporary = path.join(root, 'tmp');
  const config = path.join(root, '.claude');
  fs.mkdirSync(temporary);
  const sessionId = 'harness-types';
  const transcriptPath = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({
    type: 'assistant',
    message: {
      id: 'message-1', model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1000000, output_tokens: 500000 },
    },
  }) + '\n');
  if (cacheValue !== undefined) {
    fs.writeFileSync(path.join(temporary, `harness-cost-${sessionId}.json`),
      JSON.stringify(cacheValue(Math.floor(Date.now() / 1000))));
  }
  const input = JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath });
  const result = spawnSync(process.execPath, [hook], {
    cwd: root, input, encoding: 'utf8', timeout: 5000,
    env: {
      ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config,
      ECC_AGENT_DATA_HOME: config, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, input);
  const metricsDir = path.join(config, 'metrics');
  const row = JSON.parse(fs.readFileSync(path.join(metricsDir, 'costs.jsonl'), 'utf8').trim());
  assert.equal(row.input_tokens, 1000000);
  assert.equal(row.output_tokens, 500000);
  const snapshot = JSON.parse(fs.readFileSync(getCostSnapshotPath(metricsDir, sessionId), 'utf8'));
  assert.equal(snapshot.row.estimated_cost_usd, row.estimated_cost_usd);
  return row.estimated_cost_usd;
}

for (const [name, value] of [
  ['null', null], ['false', false], ['true', true], ['empty string', ''],
  ['whitespace', ' '], ['numeric string', '1.25'], ['empty array', []],
  ['numeric array', [2]], ['object', {}], ['missing value', undefined],
  ['invalid string', 'NaN'], ['negative value', -1],
]) {
  test(`a fresh ${name} cost falls back to transcript usage`, t => {
    assert.equal(recordedCost(t, ts => ({ ts, cost_usd: value })), transcriptCost);
  });
}

for (const [name, timestamp] of [
  ['numeric string', now => String(now)], ['numeric array', now => [now]],
  ['null', () => null], ['future', now => now + 60], ['stale', now => now - 3600],
]) {
  test(`a ${name} timestamp cannot make the cache authoritative`, t => {
    assert.equal(recordedCost(t, now => ({ ts: timestamp(now), cost_usd: 1.25 })), transcriptCost);
  });
}

for (const cost of [0, 1.25]) {
  test(`a fresh numeric cost ${cost} remains authoritative`, t => {
    assert.equal(recordedCost(t, ts => ({ ts, cost_usd: cost })), cost);
  });
}

test('an absent cache preserves the transcript estimate', t => {
  assert.equal(recordedCost(t), transcriptCost);
});

test('a non-object cache preserves the transcript estimate', t => {
  assert.equal(recordedCost(t, () => null), transcriptCost);
});
