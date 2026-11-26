'use strict';
/**
 * Loads the VS Code extension against a small stand-in for the `vscode` module,
 * to check that it activates, builds both trees and that the main commands work.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-ext-'));
process.env.SWITCHBOARD_HOME = HOME;
const root = path.join(__dirname, '..');
// the packaged extension carries its own copy of the store
fs.mkdirSync(path.join(root, 'vscode', 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'core', 'store.js'), path.join(root, 'vscode', 'lib', 'store.js'));
const store = require(path.join(root, 'vscode', 'lib', 'store.js'));

class Emitter {
  constructor() {
    this.fns = [];
    this.event = (fn) => (this.fns.push(fn), { dispose() {} });
  }
  fire(x) {
    this.fns.forEach((f) => f(x));
  }
}
class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}
const ui = { executed: [], messages: [], picks: [], inputs: [], activeTab: null, views: {}, commands: {}, status: null };
const answer = (kind) => (...a) => {
  ui.messages.push([kind, a[0]]);
  return Promise.resolve(ui[`${kind}Answer`]);
};
const vscode = {
  EventEmitter: Emitter,
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(v = '') {
      this.value = v;
    }
    appendMarkdown(s) {
      this.value += s;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  TabInputWebview,
  Uri: { parse: (s) => ({ toString: () => s, path: s.replace(/^[a-z]+:/, '') }) },
  env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
  workspace: {
    getConfiguration: () => ({ get: (k) => ({ notify: 'all', showHeadless: false, closedSessionsShown: 12 })[k] }),
    registerTextDocumentContentProvider: (_s, p) => ((ui.docs = p), { dispose() {} }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async (x) => x,
    asRelativePath: (u) => String(u),
  },
  window: {
    state: { focused: true },
    tabGroups: {
      get activeTabGroup() {
        return { activeTab: ui.activeTab };
      },
      onDidChangeTabs: (fn) => ((ui.tabsChanged = fn), { dispose() {} }),
      onDidChangeTabGroups: () => ({ dispose() {} }),
    },
    onDidChangeWindowState: () => ({ dispose() {} }),
    createTreeView: (id, opts) => (ui.views[id] = { provider: opts.treeDataProvider, badge: undefined, dispose() {} }),
    createStatusBarItem: () => (ui.status = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
    showInformationMessage: answer('info'),
    showWarningMessage: answer('warn'),
    showErrorMessage: answer('error'),
    setStatusBarMessage: () => {},
    showQuickPick: async (items, opts) => {
      const fn = ui.picks.shift();
      return fn ? fn(items, opts) : undefined;
    },
    showInputBox: async () => ui.inputs.shift(),
    showTextDocument: async () => {},
  },
  commands: {
    registerCommand: (name, fn) => ((ui.commands[name] = fn), { dispose() {} }),
    executeCommand: async (name, ...a) => {
      ui.executed.push([name, ...a]);
    },
  },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : realLoad.call(this, request, ...rest);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { subscriptions: [] };
let ext;

test('activates and groups sessions by what they need', async () => {
  const now = Date.now();
  store.upsertSession('tax', { title: 'Tax FY25-26', status: 'blocked', attention: 'Claude needs your permission to use Bash', pid: process.pid, entrypoint: 'claude-vscode', seen: false });
  store.upsertSession('biz', { title: 'Entrepreneurship', status: 'done', seen: false, pid: process.pid, entrypoint: 'claude-vscode', lastReply: 'Pricing drafted.' });
  store.upsertSession('wiki', { title: 'AWS wiki', status: 'working', pid: process.pid, entrypoint: 'claude-vscode' });
  store.upsertSession('old', { title: 'Old one', status: 'closed', entrypoint: 'claude-vscode' });
  store.upsertSession('batch', { title: 'Batch', status: 'working', pid: process.pid, headless: true });
  assert.ok(now);
  ext = require(path.join(root, 'vscode', 'extension.js'));
  ext.activate(ctx);

  const groups = ui.views['switchboard.sessions'].provider.getChildren();
  assert.deepStrictEqual(groups.map((g) => `${g.label}:${g.description}`), ['Needs you:1', 'Finished · not seen yet:1', 'Working:1', 'Closed:1']);
  const first = groups[0].children[0];
  assert.strictEqual(first.label, 'Tax FY25-26');
  assert.match(first.description, /needs your permission/);
  assert.strictEqual(first.iconPath.id, 'bell-dot');
  assert.strictEqual(ui.views['switchboard.sessions'].badge.value, 2);
  assert.match(ui.status.text, /1 needs you/);
  assert.match(ui.status.text, /1 finished/);
  assert.match(ui.status.text, /1 working/);
});

test('jump goes to the blocked session first, through the Claude extension command', async () => {
  await ui.commands['switchboard.jumpNext']();
  assert.deepStrictEqual(ui.executed.pop(), ['claude-vscode.primaryEditor.open', 'tax', undefined]);
});

test('opening a finished session marks it seen', async () => {
  await ui.commands['switchboard.openSession']('biz');
  await sleep(450);
  assert.strictEqual(store.viewState(store.getSession('biz')), 'idle');
  const groups = ui.views['switchboard.sessions'].provider.getChildren();
  assert.ok(groups.some((g) => g.label === 'Idle'));
});

test('focusing a finished session\'s tab marks it seen', async () => {
  store.upsertSession('wiki', { status: 'done', seen: false });
  await ui.commands['switchboard.refresh']();
  assert.strictEqual(store.viewState(store.getSession('wiki')), 'done');
  ui.activeTab = { label: 'AWS wiki', input: new TabInputWebview('mainThreadWebview-claudeVSCodePanel') };
  ui.tabsChanged();
  assert.strictEqual(store.viewState(store.getSession('wiki')), 'idle');
  ui.activeTab = null;
});

test('link two sessions, share a note, see it in the rooms tree and notes document', async () => {
  ui.picks.push((items) => items.filter((i) => i.id === 'tax' || i.id === 'biz'));
  ui.inputs.push('Tax + Business');
  await ui.commands['switchboard.linkSessions']({ sessionId: 'tax' });
  const room = store.resolveRoom('Tax + Business').room;
  assert.deepStrictEqual([...room.members].sort(), ['biz', 'tax']);

  ui.inputs.push('Advance tax instalment is due 15 Dec.');
  await ui.commands['switchboard.shareNote']({ roomId: room.id });
  assert.strictEqual(store.readNotes(room.id).length, 1);
  assert.strictEqual(store.unreadFor('biz')[0].notes[0].text, 'Advance tax instalment is due 15 Dec.');

  ui.inputs.push('Laptop restarts tonight.');
  await ui.commands['switchboard.broadcast']();
  assert.strictEqual(store.readNotes(store.ALL).length, 1);

  await sleep(450);
  const rooms = ui.views['switchboard.rooms'].provider.getChildren();
  assert.deepStrictEqual(rooms.map((r) => r.label), ['Everyone', 'Tax + Business']);
  const kids = rooms[1].children();
  assert.deepStrictEqual(kids.map((k) => k.contextValue), ['member', 'member', 'note']);
  const doc = ui.docs.provideTextDocumentContent({ toString: () => 'x', path: `/${room.id}/Notes.md` });
  assert.match(doc, /Advance tax instalment/);
});

test('a session that starts needing you raises a notification, unless it is the tab in front', async () => {
  ui.messages.length = 0;
  store.upsertSession('wiki', { status: 'blocked', attention: 'Asking you a question', seen: false });
  await ui.commands['switchboard.refresh']();
  await sleep(1200);
  assert.ok(ui.messages.some(([kind, msg]) => kind === 'warn' && /AWS wiki.*needs you/.test(msg)));

  ui.messages.length = 0;
  ui.activeTab = { label: 'Entrepreneurship', input: new TabInputWebview('claudeVSCodePanel') };
  store.upsertSession('biz', { status: 'done', seen: false, statusSince: Date.now() + 5 });
  await ui.commands['switchboard.refresh']();
  await sleep(1200);
  assert.strictEqual(ui.messages.length, 0);
});

test('a session whose prompt a hook refused sits under "Needs you" with the hook\'s reason', async () => {
  ui.messages.length = 0;
  const transcript = path.join(HOME, 'refused.jsonl');
  const at = Date.now();
  // What the hook stores when the prompt comes in; no Stop follows a refused prompt.
  store.upsertSession('pol', { title: 'Policy check', status: 'working', pid: process.pid, entrypoint: 'claude-vscode', transcript, promptAt: at });
  await ui.commands['switchboard.refresh']();
  const group = (name) => ui.views['switchboard.sessions'].provider.getChildren().find((g) => g.label === name);
  assert.ok(group('Working').children.some((c) => c.label === 'Policy check'));

  const notice = { isSidechain: false, type: 'system', subtype: 'informational', timestamp: new Date(at + 40).toISOString(), content: 'UserPromptSubmit operation blocked by hook:\nBaton: 104k tokens in this session.' };
  fs.writeFileSync(transcript, `${JSON.stringify(notice)}\n`);
  await ui.commands['switchboard.refresh']();
  const item = group('Needs you').children.find((c) => c.label === 'Policy check');
  assert.ok(item, 'listed under Needs you');
  assert.match(item.description, /A hook stopped your last prompt: Baton: 104k tokens in this session\./);
  assert.strictEqual(item.iconPath.id, 'bell-dot');
  assert.ok(!(group('Working') || { children: [] }).children.some((c) => c.label === 'Policy check'));
  await sleep(1200);
  assert.ok(ui.messages.some(([kind, msg]) => kind === 'warn' && /Policy check.*needs you: A hook stopped your last prompt/.test(msg)));
});

test.after(() => {
  ctx.subscriptions.forEach((d) => d && d.dispose && d.dispose());
  fs.rmSync(HOME, { recursive: true, force: true });
});
