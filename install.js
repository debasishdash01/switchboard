#!/usr/bin/env node
'use strict';
/**
 * Switchboard installer. Works on Windows, macOS and Linux; needs Node 18+ and Claude Code.
 *
 *   node install.js              install or update everything
 *   node install.js --uninstall  remove hooks, MCP server, skill and VS Code extension (shared notes are kept)
 *   node install.js --uninstall --purge   also delete ~/.switchboard
 *
 *   node install.js --build-only build dist/switchboard.vsix and change nothing else
 *
 * Optional: --no-hooks --no-mcp --no-skill --no-vscode --dry-run
 *
 * What it changes, and nothing else:
 *   ~/.switchboard/app/           a copy of core/ (the hook, MCP server and CLI run from here)
 *   ~/.claude/settings.json       adds hook entries marked "switchboard" (a backup is written first)
 *   Claude Code user MCP config   adds the "switchboard" server (through `claude mcp add`)
 *   ~/.claude/skills/switchboard  the skill
 *   VS Code                       installs the Switchboard extension from a locally built .vsix
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const ROOT = __dirname;
const HOME = process.env.SWITCHBOARD_HOME || path.join(os.homedir(), '.switchboard');
const APP = path.join(HOME, 'app');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const MARK = 'switchboard/app/hook.js'; // identifies our hook entries
const fwd = (p) => p.replace(/\\/g, '/');
const log = (s) => console.log(s);
const step = (s) => console.log(`\n== ${s}`);

/**
 * Hook entries. Status-only events run in the background so they never slow Claude down.
 * PostToolBatch (once per batch of tool calls) replaced PostToolUse (once per call): it is the event that
 * says "every call has its answer", and it starts far fewer hook processes. Tested on Claude Code 2.1.322.
 * A Claude Code too old to know the event ignores the entry and says so at startup; hook.js still
 * understands PostToolUse, so on such a version register that event by hand in its place.
 * PermissionRequest and the two PreToolUse cases are waited for (about 35 ms before a dialog; they print
 * nothing, so the dialog shows as usual). A call that cannot be asked about is refused about 15 ms after
 * its request (measured), and PostToolBatch follows at once. In the background the two could land in the
 * wrong order and leave a "needs you" for a dialog that never opened.
 */
function hookConfig(hookPath) {
  const command = `node "${fwd(hookPath)}"`;
  const h = (extra = {}) => ({ type: 'command', command, timeout: 5, ...extra });
  return {
    SessionStart: [{ hooks: [h()] }],
    UserPromptSubmit: [{ hooks: [h()] }],
    Notification: [{ hooks: [h({ async: true })] }],
    PermissionRequest: [{ hooks: [h()] }],
    PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [h()] }],
    PostToolBatch: [{ hooks: [h({ async: true })] }],
    Stop: [{ hooks: [h({ async: true })] }],
    StopFailure: [{ hooks: [h({ async: true })] }],
    SessionEnd: [{ hooks: [h()] }],
  };
}

function isOurs(entry) {
  return JSON.stringify(entry).replace(/\\\\/g, '/').includes(MARK) || JSON.stringify(entry).includes('.switchboard/app/hook.js');
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8').replace(/^﻿/, '');
  const obj = JSON.parse(raw); // strict: if this throws we stop rather than rewrite a file we cannot read
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error(`${SETTINGS} is not a JSON object`);
  if (obj.hooks !== undefined && (typeof obj.hooks !== 'object' || obj.hooks === null || Array.isArray(obj.hooks))) {
    throw new Error(`"hooks" in ${SETTINGS} is not an object; not touching it`);
  }
  return obj;
}
function writeSettings(obj, changed) {
  if (!changed) return log('   settings.json already up to date');
  if (DRY) return log('   (dry run) would update settings.json');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.switchboard-backup`;
    fs.copyFileSync(SETTINGS, backup);
    log(`   backup: ${backup}`);
  }
  const tmp = `${SETTINGS}.switchboard-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS);
  log(`   updated ${SETTINGS}`);
}
/** Remove our entries, then (when installing) add the current ones. Other people's hooks are left alone. */
function setHooks(install) {
  const settings = readSettings();
  const before = JSON.stringify(settings.hooks || {});
  const hooks = { ...(settings.hooks || {}) };
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev].filter((e) => !isOurs(e));
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (install) {
    for (const [ev, entries] of Object.entries(hookConfig(path.join(APP, 'hook.js')))) hooks[ev] = [...(hooks[ev] || []), ...entries];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  writeSettings(settings, JSON.stringify(settings.hooks || {}) !== before);
}

function run(cmd, args, opts = {}) {
  if (DRY) {
    log(`   (dry run) ${cmd} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  // shell:true so .cmd shims (claude, code, npx) resolve on Windows
  const quoted = args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return spawnSync([cmd, ...quoted].join(' '), { shell: true, encoding: 'utf8', ...opts });
}

function copyCore() {
  if (DRY) return log(`   (dry run) would copy core/ to ${APP}`);
  fs.mkdirSync(APP, { recursive: true });
  for (const f of ['store.js', 'hook.js', 'mcp.js', 'cli.js']) fs.copyFileSync(path.join(ROOT, 'core', f), path.join(APP, f));
  log(`   ${APP}`);
}

function buildVsix() {
  const stage = path.join(os.tmpdir(), `switchboard-vsix-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(stage, 'media'), { recursive: true });
  for (const f of ['package.json', 'extension.js']) fs.copyFileSync(path.join(ROOT, 'vscode', f), path.join(stage, f));
  fs.copyFileSync(path.join(ROOT, 'vscode', 'media', 'icon.svg'), path.join(stage, 'media', 'icon.svg'));
  fs.copyFileSync(path.join(ROOT, 'core', 'store.js'), path.join(stage, 'lib', 'store.js'));
  fs.writeFileSync(path.join(stage, 'README.md'), '# Switchboard\n\nSee and connect your Claude Code sessions. Built locally; see the project README.\n');
  fs.writeFileSync(path.join(stage, 'LICENSE'), 'MIT License. Local build.\n');
  const out = path.join(ROOT, 'dist', 'switchboard.vsix');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = run('npx', ['--yes', '@vscode/vsce@3', 'package', '--no-dependencies', '--allow-missing-repository', '--out', out], { cwd: stage });
  fs.rmSync(stage, { recursive: true, force: true });
  if (r.status !== 0) throw new Error(`vsce failed:\n${r.stdout}\n${r.stderr}`);
  return out;
}

function install() {
  step('Runtime files');
  copyCore();

  if (!argv.has('--no-hooks')) {
    step('Claude Code hooks');
    setHooks(true);
  }
  if (!argv.has('--no-mcp')) {
    step('MCP server (agent tools: share, read_shared, peek_session, …)');
    run('claude', ['mcp', 'remove', '--scope', 'user', 'switchboard']);
    const r = run('claude', ['mcp', 'add', '--scope', 'user', 'switchboard', '--', 'node', fwd(path.join(APP, 'mcp.js'))]);
    log(r.status === 0 ? '   registered "switchboard" for all projects' : `   FAILED: ${(r.stderr || r.stdout || '').trim()}\n   Run by hand: claude mcp add --scope user switchboard -- node "${fwd(path.join(APP, 'mcp.js'))}"`);
  }
  if (!argv.has('--no-skill')) {
    step('Skill');
    const dest = path.join(CLAUDE_DIR, 'skills', 'switchboard');
    if (!DRY) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'skill', 'SKILL.md'), path.join(dest, 'SKILL.md'));
    }
    log(`   ${dest}`);
  }
  if (!argv.has('--no-vscode')) {
    step('VS Code extension');
    try {
      if (DRY) log('   (dry run) would build and install the .vsix');
      else {
        const vsix = buildVsix();
        log(`   built ${vsix}`);
        const r = run('code', ['--install-extension', vsix, '--force']);
        log(r.status === 0 ? '   installed. Reload the VS Code window to load it.' : `   Could not run "code". Install by hand: Extensions view → … → Install from VSIX → ${vsix}`);
      }
    } catch (e) {
      log(`   FAILED: ${e.message}`);
    }
  }
  log(`
Done.
- Reload the VS Code window (Ctrl+Shift+P → "Developer: Reload Window"), then open the Switchboard icon in the activity bar.
  A reload is needed for a new or changed extension only. Changes to the store code reach an open sidebar by themselves.
- Claude sessions that were already open pick up new hook events and tools only after their tab is restarted.
- Check the setup any time with:  node "${fwd(path.join(APP, 'cli.js'))}" doctor
- Turn the hooks off without uninstalling: set the environment variable SWITCHBOARD_HOOKS_DISABLED=1`);
}

function uninstall() {
  step('Claude Code hooks');
  setHooks(false);
  step('MCP server');
  const r = run('claude', ['mcp', 'remove', '--scope', 'user', 'switchboard']);
  log(r.status === 0 ? '   removed' : '   not registered');
  step('Skill');
  if (!DRY) fs.rmSync(path.join(CLAUDE_DIR, 'skills', 'switchboard'), { recursive: true, force: true });
  log('   removed');
  step('VS Code extension');
  const u = run('code', ['--uninstall-extension', 'local.switchboard']);
  log(u.status === 0 ? '   removed' : '   not installed (or "code" is not on PATH)');
  step('Data');
  if (argv.has('--purge')) {
    if (!DRY) fs.rmSync(HOME, { recursive: true, force: true });
    log(`   deleted ${HOME}`);
  } else {
    if (!DRY) fs.rmSync(APP, { recursive: true, force: true });
    log(`   kept your rooms and notes in ${HOME} (add --purge to delete them)`);
  }
}

if (require.main === module) {
  try {
    if (argv.has('--build-only')) log(`built ${buildVsix()}`);
    else if (argv.has('--uninstall')) uninstall();
    else install();
  } catch (e) {
    console.error(`\nswitchboard install: ${e.message}`);
    process.exit(1);
  }
}
module.exports = { hookConfig };
