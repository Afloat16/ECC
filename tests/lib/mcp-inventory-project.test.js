'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { readClaudeCodeMcp } = require('../../scripts/lib/mcp-inventory/readers/claude-code');

function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-mcp-project-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  const userConfig = path.join(home, '.claude.json');
  const projectConfig = path.join(project, '.mcp.json');
  fs.writeFileSync(userConfig, JSON.stringify({
    mcpServers: { globalTool: { command: 'global-server' } },
    projects: {
      [project]: { mcpServers: { localTool: {
        command: 'local-server', env: { API_TOKEN: 'local-value-must-not-appear' },
      } } },
      [path.join(root, 'another-project')]: { mcpServers: { unrelatedTool: { command: 'unrelated' } } },
    },
  }));
  fs.writeFileSync(projectConfig, JSON.stringify({
    mcpServers: { sharedTool: { type: 'http', url: 'https://mcp.example.test' } },
  }));
  try { callback({ home, project, userConfig, projectConfig }); } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function names(records) {
  return records.map(record => record.name).sort();
}

function runCli(home, project) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/mcp-inventory.js'), '--json'], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      OPENCODE_CONFIG_DIR: path.join(home, '.config/opencode'),
    },
    encoding: 'utf8', timeout: 30000,
  });
}

test('an active project includes its local and shared servers with distinct source scopes', () => fixture(({ home, project, userConfig, projectConfig }) => {
  const records = readClaudeCodeMcp({ homeDir: home, projectDir: path.join(project, '.') });
  assert.deepEqual(names(records), ['globalTool', 'localTool', 'sharedTool']);
  assert.deepEqual(records.find(record => record.name === 'localTool').source, {
    harness: 'claude-code', scope: 'local', configPath: userConfig,
  });
  assert.deepEqual(records.find(record => record.name === 'sharedTool').source, {
    harness: 'claude-code', scope: 'project', configPath: projectConfig,
  });
}));

test('an explicit empty project path list disables implicit project files', () => fixture(({ home, project }) => {
  const records = readClaudeCodeMcp({ homeDir: home, projectDir: project, projectConfigPaths: [] });
  assert.deepEqual(names(records), ['globalTool', 'localTool']);
}));

test('explicit project paths remain supported without implicit current-directory discovery', () => fixture(({ home, projectConfig }) => {
  assert.deepEqual(names(readClaudeCodeMcp({ homeDir: home })), ['globalTool']);
  assert.deepEqual(names(readClaudeCodeMcp({ homeDir: home, projectConfigPaths: [projectConfig] })), ['globalTool', 'sharedTool']);
}));

test('a project file remains readable without a valid user configuration', () => fixture(({ home, project, userConfig }) => {
  for (const content of ['{broken', 'null', '{}', '{"projects":null}']) {
    fs.writeFileSync(userConfig, content);
    assert.deepEqual(names(readClaudeCodeMcp({ homeDir: home, projectDir: project })), ['sharedTool']);
  }
  fs.unlinkSync(userConfig);
  fs.mkdirSync(userConfig);
  assert.deepEqual(names(readClaudeCodeMcp({ homeDir: home, projectDir: project })), ['sharedTool']);
}));

test('a malformed project file does not discard user or local entries', () => fixture(({ home, project, projectConfig }) => {
  fs.writeFileSync(projectConfig, '{broken');
  assert.deepEqual(names(readClaudeCodeMcp({ homeDir: home, projectDir: project })), ['globalTool', 'localTool']);
}));

test('the inventory CLI discovers the current project and redacts local environment values', () => fixture(({ home, project }) => {
  const child = runCli(home, project);
  assert.equal(child.status, 0, child.stderr);
  const inventory = JSON.parse(child.stdout);
  assert.deepEqual(names(inventory.servers), ['globalTool', 'localTool', 'sharedTool']);
  assert.equal(inventory.aggregates.serverCount, 3);
  assert.equal(inventory.aggregates.harnessCount, 1);
  const local = inventory.servers.find(record => record.name === 'localTool');
  assert.deepEqual(local.envKeys, ['API_TOKEN']);
  assert.equal(local.hasSecrets, true);
  assert.equal(local.sources[0].scope, 'local');
  assert.ok(!child.stdout.includes('local-value-must-not-appear'));
  assert.ok(!child.stdout.includes('unrelatedTool'));
}));

test('the inventory CLI retains global-only behavior outside a configured project', () => fixture(({ home, project }) => {
  fs.unlinkSync(path.join(project, '.mcp.json'));
  const child = runCli(home, home);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(names(JSON.parse(child.stdout).servers), ['globalTool']);
}));
