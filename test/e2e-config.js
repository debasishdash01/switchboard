'use strict';
/**
 * Writes a throwaway Claude Code settings file and MCP config that point at this repo's core/,
 * for trying Switchboard with real sessions without installing it:
 *
 *   node test/e2e-config.js <dir>
 *   SWITCHBOARD_HOME=<dir>/home claude --settings <dir>/settings.json --mcp-config <dir>/mcp.json
 */
const fs = require('fs');
const path = require('path');
const { hookConfig } = require('../install.js');

const dir = path.resolve(process.argv[2] || '.');
const core = path.join(__dirname, '..', 'core');
fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: hookConfig(path.join(core, 'hook.js')) }, null, 1));
fs.writeFileSync(
  path.join(dir, 'mcp.json'),
  JSON.stringify({ mcpServers: { switchboard: { command: 'node', args: [path.join(core, 'mcp.js').split(path.sep).join('/')] } } }, null, 1)
);
console.log(`wrote ${dir}`);
