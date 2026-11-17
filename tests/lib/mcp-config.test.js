'use strict';

const assert = require('assert');

const { filterMcpConfig, parseDisabledMcpServers } = require('../../scripts/lib/mcp-config');
const { deepMergeJson, deepRemoveJsonSubset } = require('../../scripts/lib/install/json-ops');

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing mcp-config.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('parseDisabledMcpServers dedupes and trims values', () => {
    assert.deepStrictEqual(
      parseDisabledMcpServers(' github,exa ,github,,playwright '),
      ['github', 'exa', 'playwright']
    );
  })) passed++; else failed++;

  if (test('filterMcpConfig removes disabled servers and preserves others', () => {
    const result = filterMcpConfig({
      mcpServers: {
        github: { command: 'npx' },
        exa: { url: 'https://mcp.exa.ai/mcp' },
        memory: { command: 'npx' },
      },
      _comments: { usage: 'demo' },
    }, ['github', 'memory']);

    assert.deepStrictEqual(result.removed, ['github', 'memory']);
    assert.deepStrictEqual(Object.keys(result.config.mcpServers), ['exa']);
    assert.deepStrictEqual(result.config._comments, { usage: 'demo' });
  })) passed++; else failed++;

  if (test('filterMcpConfig leaves config unchanged when no disabled servers are provided', () => {
    const result = filterMcpConfig({
      mcpServers: {
        github: { command: 'npx' },
      },
    }, []);

    assert.deepStrictEqual(result.removed, []);
    assert.deepStrictEqual(Object.keys(result.config.mcpServers), ['github']);
  })) passed++; else failed++;

  if (test('MCP filtering preserves literal JSON keys without mutating the input', () => {
    const servers = Object.freeze(JSON.parse('{"__proto__":{"command":"custom"},"constructor":{"command":"other"},"disabled":{}}'));
    const config = Object.freeze({ mcpServers: servers });
    const filtered = filterMcpConfig(config, ['disabled']).config.mcpServers;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(filtered)), JSON.parse('{"__proto__":{"command":"custom"},"constructor":{"command":"other"}}'));
    assert.strictEqual(Object.getPrototypeOf(filtered), Object.prototype);
    assert.ok(Object.hasOwn(servers, 'disabled'));
    assert.deepStrictEqual(filterMcpConfig(config, ['__proto__']).removed, ['__proto__']);
    assert.ok(!Object.hasOwn(filterMcpConfig(config, ['__proto__']).config.mcpServers, '__proto__'));
  })) passed++; else failed++;

  if (test('JSON merges round-trip prototype-named values and retain user-owned nested fields', () => {
    for (const value of [null, 3, 'literal', ['entry'], { command: 'custom' }]) {
      const patch = Object.fromEntries([['__proto__', value]]);
      const merged = deepMergeJson({ preserved: true }, patch);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(merged)), { preserved: true, ...patch });
      assert.strictEqual(Object.getPrototypeOf(merged), Object.prototype);
      assert.deepStrictEqual(deepRemoveJsonSubset(merged, patch), { preserved: true });
    }
    const base = JSON.parse('{"mcpServers":{"__proto__":{"env":{"USER_SETTING":"keep"}}}}');
    const patch = JSON.parse('{"mcpServers":{"__proto__":{"command":"custom"}}}');
    const before = JSON.stringify(base);
    const merged = deepMergeJson(base, patch);
    assert.deepStrictEqual(merged.mcpServers.__proto__, { env: { USER_SETTING: 'keep' }, command: 'custom' });
    assert.deepStrictEqual(deepRemoveJsonSubset(merged, patch), base);
    assert.strictEqual(JSON.stringify(base), before);
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
