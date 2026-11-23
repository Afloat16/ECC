'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('@iarna/toml');
const { buildSignature, normalizeServerEntry } = require('../../scripts/lib/mcp-inventory/canonical-mcp');
const { collectMcpInventory } = require('../../scripts/lib/mcp-inventory/collect');
const { formatHumanReport } = require('../../scripts/mcp-inventory');
const { test } = require('./helpers/mini-test-runner');

const differingCommands = [
  ['one argument containing spaces versus two arguments', ['node', ['work dir']], ['node', ['work', 'dir']]],
  ['empty argument versus no argument', ['node', ['']], ['node', []]],
  ['trailing empty argument', ['node', ['path', '']], ['node', ['path']]],
  ['trailing space within one argument', ['node', ['path ']], ['node', ['path']]],
  ['command path versus an argument boundary', ['node tool', ['path']], ['node', ['tool', 'path']]],
  ['multiple arguments containing spaces', ['node', ['a b', 'c']], ['node', ['a', 'b c']]],
];

const cases = differingCommands.map(([name, first, second]) => [name, () => {
  const signature = ([command, args]) => buildSignature({ transport: 'stdio', command, args });
  assert.notStrictEqual(signature(first), signature(second), 'distinct argv must report configuration drift');
}]);

cases.push(
  ['identical command vectors remain consistent, including punctuation and empty strings', () => {
    const record = { name: 'same', command: 'node', args: ['["x", "y"]', '', '\\', 'λ path'] };
    const copy = structuredClone(record);
    assert.strictEqual(normalizeServerEntry(record).signature, normalizeServerEntry(copy).signature);
    assert.deepStrictEqual(record, copy, 'signature computation must leave input vectors unchanged');
  }],
  ['credential values are still redacted before comparing configurations', () => {
    const record = value => normalizeServerEntry({
      name: 'credential', command: 'node', args: ['--api-key', value, '--path', 'work dir'],
    });
    const first = record('fixture first credential');
    const second = record('fixture second credential');
    assert.strictEqual(first.signature, second.signature, 'secret-only differences remain intentionally hidden');
    assert.strictEqual(first.hasSecrets, true);
    assert.deepStrictEqual(first.args, ['--api-key', '***', '--path', 'work dir']);
    assert.ok(!JSON.stringify([first, second]).includes('fixture first credential'));
    assert.ok(!JSON.stringify([first, second]).includes('fixture second credential'));
  }],
  ['HTTP and SSE identities retain their existing URL representation', () => {
    for (const transport of ['http', 'sse']) {
      assert.strictEqual(buildSignature({ transport, url: 'https://example.invalid/mcp' }),
        `${transport}:https://example.invalid/mcp`);
    }
  }],
  ['real Claude, Codex, and OpenCode files expose argument drift in both report formats', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-signature-'));
    try {
      const claudePath = path.join(directory, 'claude.json');
      const codexPath = path.join(directory, 'codex.toml');
      const opencodePath = path.join(directory, 'opencode.json');
      const first = {
        filesystem: { command: 'node', args: ['work dir'] },
        optional: { command: 'node', args: [''] },
        same: { command: 'node', args: ['a b', ''] },
      };
      const second = {
        filesystem: { command: 'node', args: ['work', 'dir'] },
        optional: { command: 'node', args: [] },
        same: first.same,
      };
      fs.writeFileSync(claudePath, JSON.stringify({ mcpServers: first }));
      fs.writeFileSync(codexPath, TOML.stringify({ mcp_servers: second }));
      fs.writeFileSync(opencodePath, JSON.stringify({ mcp: Object.fromEntries(Object.entries(first)
        .map(([name, server]) => [name, { type: 'local', command: [server.command, ...server.args] }])) }));
      const inventory = collectMcpInventory({ readerOptions: {
        'claude-code': { userConfigPath: claudePath },
        codex: { configPath: codexPath },
        opencode: { configPath: opencodePath },
      } });
      const json = JSON.parse(JSON.stringify(inventory));
      assert.strictEqual(json.aggregates.inconsistentServerCount, 2);
      assert.deepStrictEqual(Object.fromEntries(json.servers.map(server => [server.name, server.consistent])), {
        filesystem: false, optional: false, same: true,
      });
      assert.ok(json.servers.every(server => server.sources.length === 3));
      const human = formatHumanReport(inventory);
      assert.match(human, /2 inconsistent/);
      assert.match(human, /filesystem[^\n]*DRIFT/);
      assert.match(human, /optional[^\n]*DRIFT/);
      assert.match(human, /same[^\n]*consistent/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }],
);

const results = cases.map(([name, check]) => test(name, check));
console.log(`\nPassed: ${results.filter(Boolean).length}`);
console.log(`Failed: ${results.filter(result => !result).length}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
