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
const ui = { executed: [], messages: [], picks: [], inputs: [], activeTab: null, views: {}, commands: {}, status: null, agentCalls: [], agentsOut: '[]' };
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
// `claude agents --json --all` answers with ui.agentsOut instead of running.
const realCp = require('child_process');
const cpStub = {
  ...realCp,
  execFile: (cmd, args, opts, cb) => {
    ui.agentCalls.push([cmd, ...args]);
    setImmediate(() => cb(null, ui.agentsOut, ''));
    return {};
  },
};
Module._load = function (request, ...rest) {
  if (request === 'child_process') return cpStub;
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

test('a watched session tells you once when it finishes, even with notifications off', async () => {
  const realCfg = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({ get: (k) => ({ notify: 'off', showHeadless: false, closedSessionsShown: 12 })[k] });
  try {
    ui.activeTab = null;
    store.upsertSession('wiki', { status: 'working', attention: null, seen: true, statusSince: Date.now() });
    await ui.commands['switchboard.refresh']();
    await ui.commands['switchboard.toggleWatch']({ sessionId: 'wiki' });
    assert.strictEqual(store.getSession('wiki').watch, true);
    await ui.commands['switchboard.refresh']();
    const row = ui.views['switchboard.sessions'].provider.getChildren().flatMap((g) => g.children || []).find((i) => i.sessionId === 'wiki');
    assert.match(row.description, /watching/);

    // a dialog on the way is not the end of the work
    ui.messages.length = 0;
    store.upsertSession('wiki', { status: 'blocked', attention: 'Asking you a question', seen: false, statusSince: Date.now() + 1 });
    await ui.commands['switchboard.refresh']();
    await sleep(1200);
    assert.strictEqual(ui.messages.length, 0, 'notifications are off and a dialog does not end a watch');
    assert.strictEqual(store.getSession('wiki').watch, true);

    store.upsertSession('wiki', { status: 'done', attention: null, seen: false, statusSince: Date.now() + 2 });
    await ui.commands['switchboard.refresh']();
    await sleep(1200);
    assert.deepStrictEqual(ui.messages, [['info', '"AWS wiki" finished.']]);
    assert.strictEqual(store.getSession('wiki').watch, false, 'the watch ends with its notice');

    // watching can be turned off again
    await ui.commands['switchboard.toggleWatch']({ sessionId: 'wiki' });
    await ui.commands['switchboard.toggleWatch']({ sessionId: 'wiki' });
    assert.strictEqual(store.getSession('wiki').watch, false);
  } finally {
    vscode.workspace.getConfiguration = realCfg;
  }
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

test('a refused prompt drops to Idle once its tab has been looked at; the next refusal shows again', async () => {
  const group = (name) => ui.views['switchboard.sessions'].provider.getChildren().find((g) => g.label === name);
  const under = (name) => ((group(name) || {}).children || []).some((c) => c.label === 'Policy check');
  assert.ok(under('Needs you'));
  // The user goes to that tab. Nothing is left to answer there.
  ui.activeTab = { label: 'Policy check', input: new TabInputWebview('claudeVSCodePanel') };
  ui.tabsChanged();
  await sleep(450);
  assert.ok(under('Idle'), 'looked at: idle');
  assert.ok(!under('Needs you'));

  // Another prompt is refused while the user is in a different tab.
  ui.activeTab = null;
  const transcript = store.getSession('pol').transcript;
  const at = Date.now() + 30;
  store.upsertSession('pol', { promptAt: at });
  const notice = { isSidechain: false, type: 'system', subtype: 'informational', timestamp: new Date(at + 20).toISOString(), content: 'UserPromptSubmit operation blocked by hook:\nBaton is on for this session.' };
  fs.appendFileSync(transcript, `${JSON.stringify(notice)}\n`);
  await ui.commands['switchboard.refresh']();
  assert.ok(under('Needs you'), 'a refusal that has not been looked at');

  // And one that happens in the tab the user is typing in never asks for attention.
  ui.messages.length = 0;
  ui.activeTab = { label: 'Policy check', input: new TabInputWebview('claudeVSCodePanel') };
  await sleep(60); // past the notice's time, which the test set slightly ahead
  await ui.commands['switchboard.refresh']();
  assert.ok(under('Idle'));
  await sleep(1200);
  assert.strictEqual(ui.messages.length, 0, 'no notification for the tab in front');
  ui.activeTab = null;
});

test('a status that looks stale is checked with `claude agents`, at most every 20 s, and a newer hook event wins', async () => {
  const realCfg = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({ get: (k) => ({ notify: 'off', showHeadless: false, closedSessionsShown: 12, checkWithClaudeAgents: true })[k] });
  // updateSession stamps every write with the current time, so the file is aged by hand
  const age = (id, patch) => {
    const f = path.join(HOME, 'sessions', `${id}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...patch }));
  };
  const wiki = () => ui.views['switchboard.sessions'].provider.getChildren().flatMap((g) => (g.children || []).map((i) => ({ group: g.label, item: i }))).find((x) => x.item.sessionId === 'wiki');
  try {
    ui.activeTab = null;
    ui.agentCalls.length = 0;
    ui.agentsOut = JSON.stringify([{ pid: process.pid, cwd: '/work', kind: 'interactive', startedAt: 1, sessionId: 'wiki', name: 'AWS wiki', status: 'waiting', waitingFor: 'permission prompt' }]);
    // working, and nothing heard for 3 minutes: a dialog the hooks did not report
    store.upsertSession('wiki', { status: 'working', attention: null, seen: true, bg: 0, bgBefore: 0, watch: false });
    const old = Date.now() - 3 * 60000;
    age('wiki', { updatedAt: old, statusSince: old, promptAt: old });
    await ui.commands['switchboard.refresh']();
    await sleep(300);
    assert.deepStrictEqual(ui.agentCalls, [['claude', 'agents', '--json', '--all']]);
    let x = wiki();
    assert.strictEqual(x.group, 'Needs you');
    assert.match(x.item.description, /Waiting for you: permission prompt/);
    assert.match(x.item.tooltip.value, /Status from `claude agents`/);

    // not asked again within 20 s
    await ui.commands['switchboard.refresh']();
    await sleep(100);
    assert.strictEqual(ui.agentCalls.length, 1);

    // the hooks report again (the dialog was answered): their event is newer than the list
    store.upsertSession('wiki', { status: 'working' });
    await ui.commands['switchboard.refresh']();
    x = wiki();
    assert.strictEqual(x.group, 'Working');
    assert.doesNotMatch(x.item.tooltip.value, /claude agents/);
  } finally {
    vscode.workspace.getConfiguration = realCfg;
  }
});

test('the sidebar reads the store with the installed code and picks up a change without a reload', async () => {
  const labels = () => ui.views['switchboard.sessions'].provider.getChildren().flatMap((g) => g.children.map((c) => c.label));
  assert.ok(labels().includes('Tax FY25-26'), 'nothing installed: the packaged copy');

  // What the installer puts in <home>/app. Here a "fixed" copy that names sessions differently.
  const app = path.join(HOME, 'app');
  fs.mkdirSync(app, { recursive: true });
  const src = fs.readFileSync(path.join(root, 'core', 'store.js'), 'utf8');
  const marked = src.replace("if (!s) return 'unknown session';", "if (!s) return 'unknown session';\n  if (s.title) return `${s.title} *`;");
  assert.notStrictEqual(marked, src);
  fs.writeFileSync(path.join(app, 'store.js'), marked);
  await ui.commands['switchboard.refresh']();
  assert.ok(labels().includes('Tax FY25-26 *'), 'the installed copy is in use');

  // A copy that does not load (caught half-written), one from an older version, and one that loads but
  // fails when used: none is used, however often the sidebar refreshes.
  const refreshes = async (n) => {
    for (let i = 0; i < n; i++) await ui.commands['switchboard.refresh']();
  };
  fs.writeFileSync(path.join(app, 'store.js'), 'this is not javascript (');
  await refreshes(5);
  assert.ok(labels().includes('Tax FY25-26 *'), 'a broken copy changes nothing');
  fs.writeFileSync(path.join(app, 'store.js'), "module.exports = { home: () => 'x', listSessions: () => [] };");
  await refreshes(5);
  assert.ok(labels().includes('Tax FY25-26 *'), 'a copy that lacks what the extension calls is not used');
  fs.writeFileSync(path.join(app, 'store.js'), src.replace('function viewState(s) {', "function viewState(s) {\n  throw new Error('bad build');"));
  await refreshes(5);
  assert.ok(labels().includes('Tax FY25-26 *'), 'a copy that throws when used is not used');

  // The next good copy is picked up; with none, the packaged copy again.
  fs.writeFileSync(path.join(app, 'store.js'), src);
  await ui.commands['switchboard.refresh']();
  assert.ok(labels().includes('Tax FY25-26') && !labels().includes('Tax FY25-26 *'));
  fs.writeFileSync(path.join(app, 'store.js'), marked);
  await ui.commands['switchboard.refresh']();
  assert.ok(labels().includes('Tax FY25-26 *'));
  fs.rmSync(path.join(app, 'store.js'));
  await ui.commands['switchboard.refresh']();
  assert.ok(labels().includes('Tax FY25-26') && !labels().includes('Tax FY25-26 *'));
});

test('a row says how many shared notes wait for its next prompt, and nothing wakes the tab', async () => {
  const row = (id) => ui.views['switchboard.sessions'].provider.getChildren().flatMap((g) => g.children || []).find((i) => i.sessionId === id);
  const executed = ui.executed.length;
  await ui.commands['switchboard.refresh']();
  // From the earlier test: one note in "Tax + Business" (tax and biz) and one in Everyone.
  assert.match(row('tax').description, /✉ 2 notes waiting/);
  assert.match(row('tax').tooltip.value, /Notes waiting:\*\* Tax \+ Business \(1\), Everyone \(1\)\. They arrive with this tab's next prompt/);
  assert.match(row('wiki').description, /✉ 1 note waiting/, 'not in the room: the broadcast only');
  assert.doesNotMatch(row('old').description, /waiting/, 'a closed session gets them when it is resumed');

  // A note a tab shared itself does not wait for it.
  store.postNote(store.ALL, { from: 'wiki', text: 'Wiki build is green.' });
  await ui.commands['switchboard.refresh']();
  assert.match(row('wiki').description, /✉ 1 note waiting/);
  assert.match(row('biz').description, /✉ 3 notes waiting/);

  // Delivered with the tab's next prompt: the row redraws without any other change.
  assert.strictEqual(store.collectInjection('tax').notes, 3);
  await ui.commands['switchboard.refresh']();
  assert.doesNotMatch(row('tax').description, /waiting/);
  assert.doesNotMatch(row('tax').tooltip.value, /Notes waiting/);

  // A tab that muted Everyone is not told about broadcasts.
  store.upsertSession('wiki', { muteAll: true });
  await ui.commands['switchboard.refresh']();
  assert.doesNotMatch(row('wiki').description, /waiting/);
  store.upsertSession('wiki', { muteAll: false });

  assert.strictEqual(ui.executed.length, executed, 'showing the count opens or wakes nothing');
});

test.after(() => {
  ctx.subscriptions.forEach((d) => d && d.dispose && d.dispose());
  fs.rmSync(HOME, { recursive: true, force: true });
});
