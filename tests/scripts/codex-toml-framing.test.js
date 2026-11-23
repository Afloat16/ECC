'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const TOML = require('@iarna/toml');
const { test } = require('../lib/helpers/mini-test-runner');

const repoRoot = path.resolve(__dirname, '../..');
const expectedServer = {
  command: 'npx',
  args: ['chrome-devtools-mcp@1.10.1'],
  startup_timeout_sec: 30,
};

function withConfig(original, check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-toml-framing-'));
  const configPath = path.join(directory, 'config.toml');
  try {
    fs.writeFileSync(configPath, original, 'utf8');
    const before = TOML.parse(original);
    const run = (script, args = [], env = {}) => spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts/codex', script), configPath, ...args,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CLAUDE_PACKAGE_MANAGER: 'npm',
        CLAUDE_CODE_PACKAGE_MANAGER: 'npm',
        ECC_DISABLED_MCPS: '',
        ...env,
      },
    });
    check({ before, run, read: () => fs.readFileSync(configPath, 'utf8') });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function succeeded(result) {
  assert.strictEqual(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

const serverForms = [
  ['bare table', '[mcp_servers.chrome-devtools]\ncommand = "old"\nargs = []\n'],
  ['quoted table', '[mcp_servers."chrome-devtools"]\ncommand = "old"\nargs = []\n'],
  ['spaced table', '[ mcp_servers . chrome-devtools ] # selected\ncommand = "old"\nargs = []\n'],
  ['escaped table key', '["mcp_servers" . "chrome\\u002ddevtools"]\ncommand = "old"\nargs = []\n'],
  ['literal table key', "['mcp_servers'.'chrome-devtools']\ncommand = \"old\"\nargs = []\n"],
  ['inline server', '[mcp_servers]\n"chrome-devtools" = { command = "old", args = [] }\n'],
  ['root dotted server', 'mcp_servers."chrome-devtools" = { command = "old", args = [] }\n'],
  ['dotted server fields', '[mcp_servers]\n"chrome-devtools".command = "old"\n"chrome-devtools".args = []\n'],
];

const peer = '# Keep this user configuration exactly.\n  [mcp_servers."user.tool"]\ncommand = "custom"\nargs = ["keep me", "# literal"]\n';
const prefix = 'notes = \'\'\'\n[mcp_servers.chrome-devtools]\n[features]\nExample headers, not configuration.\n\'\'\'\n';

const cases = serverForms.map(([name, server]) => [
  `MCP refresh recognizes ${name} and preserves unrelated source bytes`,
  () => withConfig(prefix + server + peer, ({ before, run, read }) => {
    succeeded(run('merge-mcp-config.js', ['--update-mcp']));
    const updated = read();
    const parsed = TOML.parse(updated);
    assert.deepStrictEqual(parsed.mcp_servers['chrome-devtools'], expectedServer);
    assert.deepStrictEqual(parsed.mcp_servers['user.tool'], before.mcp_servers['user.tool']);
    assert.strictEqual(parsed.notes, before.notes);
    assert.ok(updated.includes(prefix));
    assert.ok(updated.includes(peer));
    succeeded(run('merge-mcp-config.js'));
    assert.strictEqual(read(), updated, 'the following add-only sync must be a no-op');
  }),
]);

cases.push(
  ['MCP refresh removes every selected subtable without confusing quoted dots', () => {
    const original = '[mcp_servers.chrome-devtools]\ncommand = "old"\nargs = []\n'
      + '[mcp_servers."chrome-devtools".env]\n"literal.dot" = "old environment"\n'
      + peer
      + '[mcp_servers.chrome-devtools.custom."nested.dot"]\nvalue = "old option"\n';
    withConfig(original, ({ before, run, read }) => {
      succeeded(run('merge-mcp-config.js', ['--update-mcp']));
      const parsed = TOML.parse(read());
      assert.deepStrictEqual(parsed.mcp_servers['chrome-devtools'], expectedServer);
      assert.deepStrictEqual(parsed.mcp_servers['user.tool'], before.mcp_servers['user.tool']);
      assert.ok(read().includes(peer));
    });
  }],
  ['MCP disable removes a quoted server and preserves a following array of tables', () => {
    const original = '[mcp_servers."chrome-devtools"]\ncommand = "old"\nargs = []\n'
      + '  [[projects]]\nname = "first"\n  [[projects]]\nname = "second"\n';
    withConfig(original, ({ before, run, read }) => {
      succeeded(run('merge-mcp-config.js', [], { ECC_DISABLED_MCPS: 'chrome-devtools' }));
      const parsed = TOML.parse(read());
      assert.strictEqual(parsed.mcp_servers?.['chrome-devtools'], undefined);
      assert.deepStrictEqual(parsed.projects, before.projects);
    });
  }],
  ['MCP repair recognizes a quoted retired server without changing a peer', () => {
    const original = '[mcp_servers."exa"]\nurl = "https://mcp.exa.ai/mcp"\n' + peer;
    withConfig(original, ({ before, run, read }) => {
      succeeded(run('merge-mcp-config.js'));
      const parsed = TOML.parse(read());
      assert.strictEqual(parsed.mcp_servers.exa, undefined);
      assert.deepStrictEqual(parsed.mcp_servers['chrome-devtools'], expectedServer);
      assert.deepStrictEqual(parsed.mcp_servers['user.tool'], before.mcp_servers['user.tool']);
    });
  }],
  ['MCP dry-run leaves a valid quoted configuration byte-for-byte intact', () => {
    const original = prefix + serverForms[1][1] + peer;
    withConfig(original, ({ run, read }) => {
      succeeded(run('merge-mcp-config.js', ['--update-mcp', '--dry-run']));
      assert.strictEqual(read(), original);
    });
  }],
  ...[[], ['--dry-run']].map(args => [
    `MCP refuses a shared inline container without writing (${args.join(' ') || 'apply'})`,
    () => {
      const original = 'mcp_servers = { chrome-devtools = { command = "old", args = [] }, peer = { command = "keep" } }\n';
      withConfig(original, ({ run, read }) => {
        const result = run('merge-mcp-config.js', ['--update-mcp', ...args]);
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, /safely|unchanged/i);
        assert.strictEqual(read(), original);
      });
    },
  ]),
  ['MCP refuses an unextendable inline container in add-only mode without writing', () => {
    const original = 'mcp_servers = { peer = { command = "keep" } }\n';
    withConfig(original, ({ run, read }) => {
      assert.notStrictEqual(run('merge-mcp-config.js').status, 0);
      assert.strictEqual(read(), original);
    });
  }],
  ['MCP refresh preserves CRLF user text and multiline arrays', () => {
    const original = (prefix + serverForms[1][1] + peer
      + 'tags = [\n  "[mcp_servers.chrome-devtools]", # not a table\n  "keep",\n]\n')
      .replace(/\n/g, '\r\n');
    withConfig(original, ({ before, run, read }) => {
      succeeded(run('merge-mcp-config.js', ['--update-mcp']));
      assert.deepStrictEqual(TOML.parse(read()).mcp_servers['user.tool'], before.mcp_servers['user.tool']);
      assert.ok(read().includes(peer.replace(/\n/g, '\r\n')));
      assert.ok(read().includes(prefix.replace(/\n/g, '\r\n')));
    });
  }],
  ['baseline merge edits the real quoted inline table after multiline example text', () => {
    const original = '[agents]\nnotes = \'\'\'\nexplorer = { description = "example only" }\n\'\'\'\n'
      + '"explorer" = { description = "keep } # me" } # trailing }\n';
    withConfig(original, ({ before, run, read }) => {
      succeeded(run('merge-codex-config.js'));
      const parsed = TOML.parse(read());
      assert.strictEqual(parsed.agents.notes, before.agents.notes);
      assert.strictEqual(parsed.agents.explorer.description, before.agents.explorer.description);
      assert.strictEqual(parsed.agents.explorer.config_file, 'agents/explorer.toml');
      assert.ok(read().includes('notes = \'\'\'\nexplorer = { description = "example only" }\n\'\'\''));
      assert.ok(read().includes('# trailing }'));
    });
  }],
  ['baseline merge leaves an unextendable shared inline ancestor unchanged', () => {
    const original = 'agents = { explorer = { description = "custom explorer" } }\n';
    withConfig(original, ({ run, read }) => {
      const result = run('merge-codex-config.js');
      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /safely.*unchanged/i);
      assert.strictEqual(read(), original);
    });
  }],
);

for (const newline of ['\n', '\r\n']) {
  cases.push([`baseline merge preserves multiline values and quoted tables (${JSON.stringify(newline)})`, () => {
    const original = (prefix
      + 'message = """A basic multiline string with \\"quotes\\".\n[agents]\n"""\n'
      + 'labels = [\n  "first", # a comment with [features]\n  "second",\n]\n'
      + '[ "features" ]\ncustom = true\n'
      + '[agents]\nmax_threads = 9\n'
      + "['agents'.'explorer']\ndescription = \"keep this description\"\n")
      .replace(/\n/g, newline);
    withConfig(original, ({ before, run, read }) => {
      succeeded(run('merge-codex-config.js'));
      const updated = read();
      const parsed = TOML.parse(updated);
      assert.strictEqual(parsed.notes, before.notes);
      assert.strictEqual(parsed.message, before.message);
      assert.deepStrictEqual(parsed.labels, before.labels);
      assert.deepStrictEqual(parsed.features, { custom: true, multi_agent: true });
      assert.strictEqual(parsed.multi_agent, undefined, 'table defaults must not become root keys');
      assert.strictEqual(parsed.approval_policy, 'on-request');
      assert.strictEqual(parsed.agents.max_threads, 9);
      assert.strictEqual(parsed.agents.explorer.description, 'keep this description');
      assert.strictEqual(parsed.agents.explorer.config_file, 'agents/explorer.toml');
      succeeded(run('merge-codex-config.js'));
      assert.strictEqual(read(), updated);
    });
  }]);
}

const results = cases.map(([name, check]) => test(name, check));
console.log(`\nPassed: ${results.filter(Boolean).length}`);
console.log(`Failed: ${results.filter(result => !result).length}`);
process.exitCode = results.every(Boolean) ? 0 : 1;
