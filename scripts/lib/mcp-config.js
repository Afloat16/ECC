'use strict';

function parseDisabledMcpServers(value) {
  return [...new Set(
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  )];
}

function filterMcpConfig(config, disabledServerNames = []) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('MCP config must be a JSON object');
  }

  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('MCP config must include an mcpServers object');
  }

  const disabled = new Set(parseDisabledMcpServers(disabledServerNames));
  if (disabled.size === 0) {
    return {
      config: {
        ...config,
        mcpServers: { ...servers },
      },
      removed: [],
    };
  }

  const nextServers = { ...servers };
  const removed = [];

  for (const name of Object.keys(servers)) {
    if (disabled.has(name)) {
      removed.push(name);
      delete nextServers[name];
    }
  }

  return {
    config: {
      ...config,
      mcpServers: nextServers,
    },
    removed,
  };
}

module.exports = {
  filterMcpConfig,
  parseDisabledMcpServers,
};
