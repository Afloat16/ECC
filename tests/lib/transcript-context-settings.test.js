'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveContextThreshold, resolveContextInterval } = require('../../scripts/lib/transcript-context');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.stack}`);
    failed++;
  }
}

for (const value of ['0.5', '0x10', '0e2', '160000tokens', '1e5', '250000.9', '1_000']) {
  test(`invalid threshold ${JSON.stringify(value)} retains the default and native-budget cap`, () => {
    const env = { COMPACT_CONTEXT_THRESHOLD: value };
    assert.strictEqual(resolveContextThreshold(env, 200000), 160000);
    assert.strictEqual(resolveContextThreshold(env, 1000000), 250000);
    assert.strictEqual(resolveContextThreshold({ ...env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '120000' }, 200000), 96000);
  });
}

for (const value of ['1.5', '30000tokens', '1e5', '1_000']) {
  test(`invalid interval ${JSON.stringify(value)} retains the 60000-token growth step`, () => {
    assert.strictEqual(resolveContextInterval({ COMPACT_CONTEXT_INTERVAL: value }), 60000);
  });
}

test('whole decimal counts preserve whitespace, signs, leading zeros, and numeric injection', () => {
  for (const value of [' 00160000 ', '+160000', 160000]) {
    assert.strictEqual(resolveContextThreshold({ COMPACT_CONTEXT_THRESHOLD: value }, 1000000), 160000);
  }
  for (const value of [' 00030000 ', '+30000', 30000]) {
    assert.strictEqual(resolveContextInterval({ COMPACT_CONTEXT_INTERVAL: value }), 30000);
  }
});

test('explicit zero disables only the threshold and existing numeric bounds remain intact', () => {
  for (const value of ['0', ' 00 ', '+0', '-0', 0]) {
    assert.strictEqual(resolveContextThreshold({ COMPACT_CONTEXT_THRESHOLD: value }, 200000), 0);
    assert.strictEqual(resolveContextInterval({ COMPACT_CONTEXT_INTERVAL: value }), 60000);
  }
  assert.strictEqual(resolveContextThreshold({ COMPACT_CONTEXT_THRESHOLD: '10000000' }, 200000), 10000000);
  assert.strictEqual(resolveContextInterval({ COMPACT_CONTEXT_INTERVAL: '10000000' }), 10000000);
  for (const value of ['', ' ', '-1', '10000001', 'Infinity', null, undefined]) {
    assert.strictEqual(resolveContextThreshold({ COMPACT_CONTEXT_THRESHOLD: value }, 200000), 160000);
    assert.strictEqual(resolveContextInterval({ COMPACT_CONTEXT_INTERVAL: value }), 60000);
  }
});

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-context-settings-'));
process.once('exit', () => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
let sequence = 0;

function createHookFixture(settings) {
  const sessionId = `settings-${++sequence}`;
  const transcript = path.join(fixtureRoot, `${sessionId}.jsonl`);
  return {
    run(tokens) {
      fs.writeFileSync(transcript, `${JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: tokens } }
      })}\n`);
      const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/hooks/suggest-compact.js')], {
        input: JSON.stringify({ session_id: sessionId, transcript_path: transcript }),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          TMPDIR: fixtureRoot,
          TMP: fixtureRoot,
          TEMP: fixtureRoot,
          COMPACT_THRESHOLD: '10000',
          COMPACT_CONTEXT_THRESHOLD: '160000',
          COMPACT_CONTEXT_INTERVAL: '60000',
          ECC_CONTEXT_WINDOW_TOKENS: '200000',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: '',
          ECC_CONTEXT_GATE_MODE: 'off',
          ...settings
        }
      });
      assert.ifError(result.error);
      assert.strictEqual(result.status, 0, result.stderr);
      return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '';
    }
  };
}

for (const value of ['0.5', '0x10']) {
  test(`real hook still emits a context reminder for malformed threshold ${value}`, () => {
    const fixture = createHookFixture({ COMPACT_CONTEXT_THRESHOLD: value });
    assert.match(fixture.run(180000), /Context ~180k tokens/);
  });
}

test('real hook does not repeat after one token when the interval is fractional', () => {
  const fixture = createHookFixture({ COMPACT_CONTEXT_INTERVAL: '1.5' });
  assert.match(fixture.run(160000), /Context ~160k tokens/);
  assert.strictEqual(fixture.run(160001), '');
  assert.match(fixture.run(220000), /Context ~220k tokens/);
});

test('real hook keeps an explicit zero threshold disabled', () => {
  const fixture = createHookFixture({ COMPACT_CONTEXT_THRESHOLD: '0' });
  assert.strictEqual(fixture.run(180000), '');
});

console.log(`\nPassed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
