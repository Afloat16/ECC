'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Claude Code stores MCP servers under "mcpServers" in ~/.claude.json (user
// scope), its projects[path].mcpServers (local scope), and project-local
// .mcp.json files (project scope). Each entry:
//   { type: "stdio"|"http"|"sse", command, args[], env{}, url }
function mapClaudeServer(name, raw, source) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return {
    name,
    type: typeof raw.type === 'string' ? raw.type : (raw.url ? 'http' : 'stdio'),
    command: raw.command || null,
    args: Array.isArray(raw.args) ? raw.args : [],
    url: raw.url || null,
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    enabled: raw.disabled === true ? false : true,
    source
  };
}

function readConfig(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function mapMcpServersBlock(parsed, filePath, scope) {
  const block = parsed && typeof parsed.mcpServers === 'object' && parsed.mcpServers
    ? parsed.mcpServers
    : {};

  return Object.entries(block)
    .map(([name, raw]) => mapClaudeServer(name, raw, {
      harness: 'claude-code',
      scope,
      configPath: filePath
    }))
    .filter(Boolean);
}

function readClaudeCodeMcp(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const userConfig = options.userConfigPath || path.join(homeDir, '.claude.json');
  // Only an explicitly selected project is inspected. Library callers that
  // supply an isolated home must not accidentally read the caller's project.
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  const projectConfigPaths = Array.isArray(options.projectConfigPaths)
    ? options.projectConfigPaths
    : (projectDir ? [path.join(projectDir, '.mcp.json')] : []);
  const user = readConfig(userConfig);

  const records = [
    ...mapMcpServersBlock(user, userConfig, 'user')
  ];
  if (projectDir) {
    records.push(...mapMcpServersBlock(user?.projects?.[projectDir], userConfig, 'local'));
  }

  for (const projectPath of projectConfigPaths) {
    records.push(...mapMcpServersBlock(readConfig(projectPath), projectPath, 'project'));
  }

  return records;
}

module.exports = {
  readClaudeCodeMcp,
  mapClaudeServer
};
