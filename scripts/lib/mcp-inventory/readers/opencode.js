'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveOpencodeConfigRoot } = require('../../opencode-paths');
const { resolveInvocationEnvironment } = require('../../invocation-environment');
const { parseJsoncConfig } = require('../../install/hook-consent');

// OpenCode V1 stores MCP servers under "mcp"; V2 uses "mcp.servers".
// Shape differs from Claude/Codex:
//   { type: "local"|"remote", command: ["npx","-y","pkg"], environment: {},
//     enabled: bool (V1), disabled: bool (V2), url: "https://..." }
// command is an ARRAY (binary + args combined); environment (not env) holds
// secrets; type "local" => stdio, "remote" => http/sse.
function mapOpencodeServer(name, raw, configPath) {
  if (!isRecord(raw)) {
    return null;
  }

  const commandArray = Array.isArray(raw.command) ? raw.command.filter(item => typeof item === 'string') : [];
  const [command, ...args] = commandArray;

  return {
    name,
    type: typeof raw.type === 'string' ? raw.type : (raw.url ? 'remote' : 'local'),
    command: command || (typeof raw.command === 'string' ? raw.command : null),
    args: command ? args : (Array.isArray(raw.args) ? raw.args : []),
    url: typeof raw.url === 'string' ? raw.url : null,
    env: raw.environment && typeof raw.environment === 'object'
      ? raw.environment
      : (raw.env && typeof raw.env === 'object' ? raw.env : {}),
    enabled: raw.enabled !== false && raw.disabled !== true,
    source: {
      harness: 'opencode',
      scope: 'user',
      configPath
    }
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isServerConfig(value) {
  return isRecord(value) && (
    typeof value.type === 'string' || Array.isArray(value.command)
    || typeof value.command === 'string' || typeof value.url === 'string'
    || typeof value.enabled === 'boolean' || typeof value.disabled === 'boolean'
  );
}

function serverEntries(config) {
  const block = isRecord(config.mcp) ? config.mcp : config.mcpServers;
  if (!isRecord(block)) {
    return { entries: [], replace: false };
  }
  // A V1 server may itself be named "servers" or "timeout".
  if (isRecord(block.servers) && !isServerConfig(block.servers)) {
    return { entries: Object.entries(block.servers), replace: true };
  }
  return {
    entries: Object.entries(block).filter(([name, raw]) => name !== 'timeout' || isServerConfig(raw)),
    replace: false,
  };
}

function mergeLegacyServer(previous, current) {
  const merged = { ...previous, ...current };
  for (const key of ['environment', 'env']) {
    if (isRecord(previous[key]) && isRecord(current[key])) {
      merged[key] = { ...previous[key], ...current[key] };
    }
  }
  return merged;
}

function readOpencodeMcp(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const configRoot = resolveOpencodeConfigRoot({
    homeDir,
    env: resolveInvocationEnvironment(options),
  });
  const isFile = candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile();
  let configPaths;
  if (options.configPath) {
    configPaths = [options.configPath].filter(isFile);
  } else {
    // OpenCode loads both modern files, with JSONC taking precedence.
    configPaths = [
      path.join(configRoot, 'opencode.json'),
      path.join(configRoot, 'opencode.jsonc'),
    ].filter(isFile);
    if (configPaths.length === 0) {
      const legacy = [
        path.join(configRoot, 'config.json'),
        path.join(homeDir, '.opencode.json')
      ].find(isFile);
      configPaths = legacy ? [legacy] : [];
    }
  }

  const servers = new Map();
  try {
    for (const configPath of configPaths) {
      const parsed = parseJsoncConfig(fs.readFileSync(configPath, 'utf8'), configPath);
      const { entries, replace } = serverEntries(parsed);
      for (const [name, raw] of entries) {
        if (!isRecord(raw)) continue;
        const previous = servers.get(name);
        // V2 replaces a named server as a whole; V1 inherits its settings.
        const value = previous && !replace ? mergeLegacyServer(previous.raw, raw) : raw;
        servers.set(name, { raw: value, configPath });
      }
    }
  } catch {
    return [];
  }

  return [...servers].map(([name, { raw, configPath }]) => mapOpencodeServer(name, raw, configPath));
}

module.exports = {
  readOpencodeMcp,
  mapOpencodeServer
};
