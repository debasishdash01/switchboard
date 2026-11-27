'use strict';
/**
 * Switchboard for VS Code.
 * Reads the file store written by the Claude Code hook and shows:
 *   - a Sessions view (status, "needs you", jump to a session)
 *   - a Rooms view (linked sessions, shared notes, pinned briefs)
 *   - a status-bar counter and notifications
 * It talks to the Claude Code extension only through its public commands, and runs one documented
 * Claude Code command (`claude agents --json --all`) when a status looks stale.
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const path = require('path');
const bundled = require('./lib/store.js');

/**
 * The store code in use. The extension carries a copy, but the installer also puts one in
 * ~/.switchboard/app, the copy every hook runs from. That one is used when it is there and re-read
 * when it changes, so the sidebar and the hooks read the store the same way and a fix to the store code
 * reaches an open window without a reload. A copy that does not load, or is older than this extension
 * (lacks a function it calls), is not used.
 */
let store = bundled;
let storeStamp = '';
let storeTries = 0;
function syncStore() {
  let file = '';
  let stamp = 'bundled';
  if (vscode.workspace.getConfiguration('switchboard').get('useInstalledStore') !== false) {
    try {
      file = path.join(bundled.home(), 'app', 'store.js');
      const st = fs.statSync(file);
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch {
      file = ''; // not installed there (a development run): the bundled copy
    }
  }
  if (stamp !== storeStamp) storeTries = 0;
  else if (!storeTries) return false; // this version of the file is in use, or was given up on
  storeStamp = stamp;
  let next = bundled;
  if (file) {
    try {
      delete require.cache[require.resolve(file)];
      const fresh = require(file);
      const missing = Object.keys(bundled).filter((k) => typeof bundled[k] === 'function' && typeof fresh[k] !== 'function');
      if (missing.length) throw new Error(`it is older than this extension (no ${missing.slice(0, 3).join(', ')})`);
      // It must also work on the store as it is now: the sidebar calls these on every refresh.
      for (const s of fresh.listSessions({ includeHeadless: true })) fresh.viewState(s);
      fresh.listRooms();
      next = fresh;
      storeTries = 0;
    } catch (e) {
      // Caught half-copied, held open for a moment, or broken: stay on what works. The same file is
      // tried three times (the next refreshes); a file that changes is tried again from the start.
      storeTries = storeTries >= 2 ? 0 : storeTries + 1;
      if (!storeTries) console.error(`switchboard: not using ${file}: ${e && e.message}`);
      next = store;
    }
  }
  if (next === store) return false;
  store = next;
  return true;
}

const STATE = {
  blocked: { group: 'Needs you', icon: 'bell-dot', color: 'charts.red', order: 0 },
  done: { group: 'Finished · not seen yet', icon: 'circle-filled', color: 'charts.blue', order: 1 },
  working: { group: 'Working', icon: 'sync~spin', color: 'charts.yellow', order: 2 },
  idle: { group: 'Idle', icon: 'circle-outline', color: undefined, order: 3 },
  closed: { group: 'Closed', icon: 'history', color: 'disabledForeground', order: 4 },
};

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
const cfg = () => vscode.workspace.getConfiguration('switchboard');
const nameOf = (id) => (id === 'user' ? 'You' : store.displayName(store.getSession(id)));
const mdEscape = (s) => String(s || '').replace(/[\\`*_{}[\]<>]/g, '\\$&');

// ───────────────────────── second opinion: `claude agents --json --all` ─────────────────────────
// Claude Code's own list of live sessions says busy, waiting or idle. It is asked only when a stored status
// looks stale (store.looksStale), at most every 20 s, and about the same unchanged state again only after a
// growing pause (30 s, 1, 2, 4 … up to 30 min), so a session that waits an hour for an answer costs a
// handful of calls. It is a local command: no tokens. Three failures in a row and this window stops asking.
const agents = { snap: null, busy: false, lastAt: 0, asked: new Map(), failures: 0 };
const AGENTS_GAP_MS = 20000;

function askAgents(stale, done) {
  if (cfg().get('checkWithClaudeAgents') !== true || agents.busy || agents.failures >= 3) return;
  const now = Date.now();
  if (now - agents.lastAt < AGENTS_GAP_MS) return;
  const due = stale.filter(({ key }) => {
    const a = agents.asked.get(key);
    return !a || now - a.at > Math.min(30 * 60000, 30000 * 2 ** a.n);
  });
  if (!due.length) return;
  agents.busy = true;
  agents.lastAt = now;
  const set = String(cfg().get('claudePath') || '').trim();
  const run = (cmd, retry) =>
    // Claude Code's update checks and telemetry are turned off for this call (fixed rule 1: local only).
    execFile(cmd, ['agents', '--json', '--all'], { timeout: 10000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }, (err, stdout) => {
      // A VS Code started before ~/.local/bin was on the PATH cannot find `claude`; the native installer puts it there.
      if (err && err.code === 'ENOENT' && retry) return run(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), false);
      agents.busy = false;
      const snap = err ? null : store.parseAgents(stdout, Date.now());
      if (!snap) {
        agents.failures++;
        if (agents.failures >= 3) console.error(`switchboard: stopped asking \`claude agents\` (${err ? err.message : 'output not understood'})`);
        return;
      }
      agents.failures = 0;
      agents.snap = snap;
      for (const { key } of due) {
        const a = agents.asked.get(key);
        agents.asked.set(key, { n: a ? a.n + 1 : 0, at: Date.now() });
      }
      if (agents.asked.size > 500) agents.asked.clear();
      done();
    });
  run(set || 'claude', !set);
}

// ───────────────────────── model ─────────────────────────

class Model {
  constructor() {
    this.sessions = [];
    this.rooms = [];
    this.onChange = new vscode.EventEmitter();
    this.onAttention = new vscode.EventEmitter(); // fires { session, state } when a session starts needing the user
    this.onWatchEnd = new vscode.EventEmitter(); // fires { session, state } when a watched session stops working
    this.prev = null;
  }
  load() {
    let sessions = [];
    let rooms = [];
    try {
      sessions = store.listSessions({ includeHeadless: cfg().get('showHeadless'), prune: true });
      rooms = store.listRooms();
      // What looks stale is judged on what the hooks wrote, before the second opinion is applied.
      const now = Date.now();
      // One key per unchanged state: a new sign of life (the hook or the transcript) starts the pauses over.
      this.stale = sessions
        .filter((s) => store.looksStale(s, now))
        .map((s) => ({ id: s.id, key: `${s.id}:${s.status}:${Math.max(s.updatedAt || 0, s.activeAt || 0)}` }));
      const snap = cfg().get('checkWithClaudeAgents') === true ? agents.snap : null; // turned off: no old answers either
      for (const s of sessions) store.applyAgentView(s, snap, now);
      for (const s of sessions) s.view = store.viewState(s);
    } catch (e) {
      console.error('switchboard: load failed', e);
      return false; // keep what is shown
    }
    const next = new Map(sessions.map((s) => [s.id, s.view]));
    if (this.prev) {
      for (const s of sessions) {
        const before = this.prev.get(s.id);
        if ((s.view === 'blocked' || s.view === 'done') && before !== s.view) this.onAttention.fire({ session: s, state: s.view });
        // A watched session that finished, was interrupted or closed. A dialog is not the end of its work.
        if (s.watch && before && before !== s.view && ['done', 'idle', 'closed'].includes(s.view)) this.onWatchEnd.fire({ session: s, state: s.view });
      }
    }
    this.prev = next;
    this.sessions = sessions;
    this.rooms = rooms;
    // Redraw only when something visible changed (ages are shown to the minute).
    const sig = JSON.stringify([
      Math.floor(Date.now() / 60000),
      sessions.map((s) => [s.id, s.view, s.attention, store.displayName(s), s.bg, s.muteAll, s.watch, s.statusSince, s.lastPrompt]),
      rooms.map((r) => [r.id, r.name, r.members, store.readNotes(r.id, { limit: 1 }).map((n) => n.id), store.getPin(r.id).length]),
    ]);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.onChange.fire();
    return true;
  }
  get(id) {
    return this.sessions.find((s) => s.id === id) || store.getSession(id);
  }
  roomsOf(id) {
    return this.rooms.filter((r) => !r.everyone && r.members.includes(id));
  }
  needing() {
    // oldest first inside each kind, blocked before finished
    const by = (state) => this.sessions.filter((s) => s.view === state).sort((a, b) => (a.statusSince || 0) - (b.statusSince || 0));
    return [...by('blocked'), ...by('done')];
  }
}

// ───────────────────────── tree: sessions ─────────────────────────

function sessionItem(model, s, contextValue = 'session') {
  const st = STATE[s.view] || STATE.idle;
  const item = new vscode.TreeItem(store.displayName(s), vscode.TreeItemCollapsibleState.None);
  item.id = `${contextValue}:${s.id}`;
  item.sessionId = s.id;
  const rooms = model.roomsOf(s.id).map((r) => r.name);
  const bits = [];
  if (s.view === 'blocked' && s.attention) bits.push(s.attention);
  if (rooms.length) bits.push(`⇄ ${rooms.join(', ')}`);
  if (s.bg) bits.push(`${s.bg} background`);
  if (s.entrypoint && s.entrypoint !== 'claude-vscode') bits.push('terminal');
  if (s.muteAll) bits.push('muted');
  if (s.watch) bits.push('watching');
  bits.push(ago(s.statusSince || s.updatedAt));
  item.description = bits.join(' · ');
  item.iconPath = new vscode.ThemeIcon(st.icon, st.color ? new vscode.ThemeColor(st.color) : undefined);
  item.contextValue = contextValue;
  item.command = { command: 'switchboard.openSession', title: 'Open Session', arguments: [s.id] };
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${mdEscape(store.displayName(s))}** — ${st.group.toLowerCase()} for ${ago(s.statusSince)}\n\n`);
  if (s.attention) tip.appendMarkdown(`⚠ ${mdEscape(s.attention)}\n\n`);
  if (s.lastPrompt) tip.appendMarkdown(`**Last prompt:** ${mdEscape(s.lastPrompt)}\n\n`);
  if (s.lastReply) tip.appendMarkdown(`**Last reply:** ${mdEscape(s.lastReply)}\n\n`);
  if (rooms.length) tip.appendMarkdown(`**Linked in:** ${mdEscape(rooms.join(', '))}\n\n`);
  if (s.agentView) tip.appendMarkdown(`_Status from \`claude agents\` at ${new Date(s.agentView).toLocaleTimeString()}: the hooks had not reported it._\n\n`);
  tip.appendMarkdown(`\`${s.cwd || ''}\` · \`${s.id.slice(0, 8)}\``);
  item.tooltip = tip;
  return item;
}

class SessionsProvider {
  constructor(model) {
    this.model = model;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    model.onChange.event(() => this._emitter.fire());
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return el.children || [];
    const groups = [];
    for (const [state, st] of Object.entries(STATE).sort((a, b) => a[1].order - b[1].order)) {
      let list = this.model.sessions.filter((s) => s.view === state);
      if (!list.length) continue;
      if (state === 'closed') list = list.slice(0, Math.max(0, cfg().get('closedSessionsShown')));
      if (!list.length) continue;
      const g = new vscode.TreeItem(
        st.group,
        state === 'closed' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
      );
      g.id = `group:${state}`;
      g.description = String(list.length);
      g.contextValue = 'group';
      g.children = list.map((s) => sessionItem(this.model, s));
      groups.push(g);
    }
    return groups;
  }
}

// ───────────────────────── tree: rooms ─────────────────────────

class RoomsProvider {
  constructor(model) {
    this.model = model;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    model.onChange.event(() => this._emitter.fire());
  }
  getTreeItem(el) {
    return el;
  }
  getChildren(el) {
    if (el) return el.children ? el.children() : [];
    return this.model.rooms.map((room) => {
      const notes = store.readNotes(room.id);
      const pin = store.getPin(room.id);
      const item = new vscode.TreeItem(room.name, room.everyone ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      item.id = `room:${room.id}`;
      item.roomId = room.id;
      item.contextValue = room.everyone ? 'roomAll' : 'room';
      item.iconPath = new vscode.ThemeIcon(room.everyone ? 'broadcast' : 'link');
      const who = room.everyone ? 'every session' : `${room.members.length} session${room.members.length === 1 ? '' : 's'}`;
      item.description = `${who} · ${notes.length} note${notes.length === 1 ? '' : 's'}${pin ? ' · pinned brief' : ''}`;
      item.tooltip = room.everyone
        ? 'Notes shared here reach every Claude session with its next prompt (except sessions you muted).'
        : 'Sessions in this room receive each other\'s shared notes with their next prompt, and their agents may read each other\'s recent turns.';
      item.children = () => {
        const kids = [];
        if (pin) {
          const p = new vscode.TreeItem('Pinned brief', vscode.TreeItemCollapsibleState.None);
          p.id = `pin:${room.id}`;
          p.roomId = room.id;
          p.description = store.oneLine(pin, 70);
          p.iconPath = new vscode.ThemeIcon('pinned');
          p.contextValue = 'pin';
          p.tooltip = pin;
          p.command = { command: 'switchboard.editPin', title: 'Edit Pinned Brief', arguments: [p] };
          kids.push(p);
        }
        for (const id of room.members) {
          const s = this.model.get(id);
          if (!s) continue;
          if (!s.view) s.view = store.viewState(s);
          const m = sessionItem(this.model, s, 'member');
          m.id = `member:${room.id}:${id}`;
          m.roomId = room.id;
          kids.push(m);
        }
        for (const n of notes.slice(-5).reverse()) {
          const it = new vscode.TreeItem(store.oneLine(n.text, 60), vscode.TreeItemCollapsibleState.None);
          it.id = `note:${room.id}:${n.id}`;
          it.roomId = room.id;
          it.description = `${n.from === 'user' ? 'you' : n.fromName} · ${ago(n.ts)}`;
          it.iconPath = new vscode.ThemeIcon('comment');
          it.contextValue = 'note';
          it.tooltip = new vscode.MarkdownString(`**${mdEscape(n.fromName)}** · ${store.when(n.ts)}\n\n${mdEscape(store.clip(n.text, 1200))}`);
          it.command = { command: 'switchboard.openNotes', title: 'Open Notes', arguments: [it] };
          kids.push(it);
        }
        return kids;
      };
      return item;
    });
  }
}

// ───────────────────────── notes as a read-only document ─────────────────────────

class NotesDocs {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
    this.open = new Set();
  }
  uri(room) {
    return vscode.Uri.parse(`switchboard:/${encodeURIComponent(room.id)}/${encodeURIComponent(`Notes — ${room.name}`)}.md`);
  }
  refresh() {
    for (const u of this.open) this._emitter.fire(vscode.Uri.parse(u));
  }
  provideTextDocumentContent(uri) {
    this.open.add(uri.toString());
    const roomId = decodeURIComponent(uri.path.split('/')[1]);
    const room = store.getRoom(roomId);
    if (!room) return 'This room no longer exists.';
    const lines = [`# ${room.name}`, ''];
    lines.push(room.everyone ? '_Every Claude session receives these notes._' : `_Members: ${room.members.map(nameOf).join(', ') || 'none'}_`, '');
    const pin = store.getPin(room.id);
    if (pin) lines.push('## Pinned brief', '', pin, '');
    const notes = store.readNotes(room.id);
    lines.push(`## Notes (${notes.length})`, '');
    if (!notes.length) lines.push('No notes yet.');
    for (const n of notes.slice().reverse()) lines.push(`### ${n.fromName} · ${store.when(n.ts)}`, '', n.text, '');
    return lines.join('\n');
  }
}

// ───────────────────────── activation ─────────────────────────

function activate(context) {
  syncStore();
  store.ensure();
  const model = new Model();
  const sessionsView = vscode.window.createTreeView('switchboard.sessions', { treeDataProvider: new SessionsProvider(model), showCollapseAll: false });
  const roomsView = vscode.window.createTreeView('switchboard.rooms', { treeDataProvider: new RoomsProvider(model) });
  const docs = new NotesDocs();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'switchboard.quickSwitch';
  context.subscriptions.push(sessionsView, roomsView, status, vscode.workspace.registerTextDocumentContentProvider('switchboard', docs));

  // ── the Claude tab the user is looking at ──
  function activeClaudeSession() {
    if (!vscode.window.state.focused) return null;
    const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
    if (!tab || !(tab.input instanceof vscode.TabInputWebview) || !/claude/i.test(tab.input.viewType)) return null;
    const label = String(tab.label || '').trim().toLowerCase().replace(/(\.\.\.|…)$/, '');
    if (!label) return null;
    const open = model.sessions.filter((s) => s.view !== 'closed');
    const names = (s) => [s.title, s.label].filter(Boolean).map((n) => n.trim().toLowerCase());
    let hits = open.filter((s) => names(s).some((n) => n === label));
    if (!hits.length) hits = open.filter((s) => names(s).some((n) => n.startsWith(label) || label.startsWith(n)));
    return hits.length === 1 ? hits[0] : null;
  }
  // What stops asking for attention once the user has looked: a finished turn, and a prompt a hook refused.
  const clearsWhenSeen = (s) => s.view === 'done' || (s.view === 'blocked' && s.refused);
  function seeActive() {
    const s = activeClaudeSession();
    if (s && clearsWhenSeen(s)) {
      store.markSeen(s.id);
      schedule();
    }
  }

  // ── refresh ──
  let timer = null;
  function schedule(ms = 200) {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }
  function refresh() {
    if (syncStore()) model.sig = null; // other code may read the store differently: draw again
    model.load();
    askAgents(model.stale || [], () => schedule(0));
    // The tab in front has been looked at, whatever the notification setting says.
    const front = activeClaudeSession();
    if (front && clearsWhenSeen(front)) {
      store.markSeen(front.id);
      model.load();
    }
    const blocked = model.sessions.filter((s) => s.view === 'blocked').length;
    const done = model.sessions.filter((s) => s.view === 'done').length;
    const working = model.sessions.filter((s) => s.view === 'working').length;
    const need = blocked + done;
    sessionsView.badge = need ? { value: need, tooltip: `${blocked} waiting for you, ${done} finished and not seen` } : undefined;
    const parts = [];
    if (blocked) parts.push(`$(bell-dot) ${blocked} need${blocked === 1 ? 's' : ''} you`);
    if (done) parts.push(`$(circle-filled) ${done} finished`);
    if (working) parts.push(`$(sync~spin) ${working} working`);
    status.text = parts.length ? parts.join('  ') : '$(circle-outline) Claude sessions idle';
    status.tooltip = 'Switchboard — click to switch session (Ctrl+Alt+J). Ctrl+Alt+U jumps to the next one that needs you.';
    status.backgroundColor = blocked ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (model.sessions.length) status.show();
    else status.hide();
    docs.refresh();
  }

  // ── notifications (not for the tab in front of you; delayed so quick flips do not flash) ──
  const pending = new Map();
  context.subscriptions.push(
    model.onAttention.event(({ session, state }) => {
      // A watched session gets its own notice when it finishes (below), whatever the setting says.
      if (state === 'done' && session.watch) return;
      const mode = cfg().get('notify');
      if (mode === 'off' || (mode === 'blocked' && state !== 'blocked')) return;
      clearTimeout(pending.get(session.id));
      pending.set(
        session.id,
        setTimeout(async () => {
          pending.delete(session.id);
          const now = model.get(session.id);
          if (!now || store.viewState(now) !== state) return;
          const active = activeClaudeSession();
          if (active && active.id === session.id) {
            if (clearsWhenSeen(active)) {
              store.markSeen(session.id);
              schedule();
            }
            return;
          }
          const name = store.displayName(now);
          const msg = state === 'blocked' ? `"${name}" needs you: ${now.attention || 'waiting for your answer'}` : `"${name}" finished.`;
          const show = state === 'blocked' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
          const pick = await show(msg, 'Open');
          if (pick === 'Open') openSession(session.id);
        }, 1000)
      );
    })
  );

  // ── watched sessions: one notice when the work ends, even with notifications off, then the watch ends ──
  context.subscriptions.push(
    model.onWatchEnd.event(({ session, state }) => {
      setTimeout(async () => {
        const now = model.get(session.id);
        if (!now || !now.watch || store.viewState(now) !== state) return;
        store.upsertSession(session.id, { watch: false });
        schedule();
        const active = activeClaudeSession();
        if (active && active.id === session.id) return; // it is in front of you
        const name = store.displayName(now);
        if (state === 'closed') return vscode.window.showInformationMessage(`"${name}" closed.`);
        const msg = state === 'done' ? `"${name}" finished.` : `"${name}" stopped (interrupted, or nothing left to do).`;
        const pick = await vscode.window.showInformationMessage(msg, 'Open');
        if (pick === 'Open') openSession(session.id);
      }, 1000);
    })
  );

  // ── opening sessions through the Claude Code extension's own commands ──
  async function openSession(arg, prompt) {
    const id = typeof arg === 'string' ? arg : arg && arg.sessionId;
    if (!id) return;
    const s = store.getSession(id);
    if (s && s.entrypoint && s.entrypoint !== 'claude-vscode' && store.viewState(s) !== 'closed') {
      const pick = await vscode.window.showInformationMessage(
        `"${store.displayName(s)}" is running in a terminal, so Switchboard cannot bring it to the front. Opening it here would resume a second copy.`,
        'Open a copy here'
      );
      if (pick !== 'Open a copy here') return;
    }
    try {
      await vscode.commands.executeCommand('claude-vscode.primaryEditor.open', id, prompt);
    } catch (e) {
      try {
        await vscode.env.openExternal(
          vscode.Uri.parse(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(id)}${prompt ? `&prompt=${encodeURIComponent(prompt)}` : ''}`)
        );
      } catch {
        vscode.window.showErrorMessage(`Switchboard could not open the session. Is the Claude Code extension installed? (${e && e.message})`);
        return;
      }
    }
    store.markSeen(id);
    schedule();
  }

  // ── pickers ──
  async function pickSession(placeHolder, filter = () => true) {
    const items = model.sessions.filter(filter).map((s) => ({
      label: `$(${(STATE[s.view] || STATE.idle).icon.replace('~spin', '')}) ${store.displayName(s)}`,
      description: `${(STATE[s.view] || STATE.idle).group} · ${ago(s.statusSince)}`,
      detail: s.attention || s.lastPrompt || '',
      id: s.id,
    }));
    if (!items.length) {
      vscode.window.showInformationMessage('No sessions to choose from.');
      return null;
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    return pick ? pick.id : null;
  }
  async function pickSessions(placeHolder, preselect = [], filter = () => true) {
    const items = model.sessions
      .filter((s) => s.view !== 'closed' || preselect.includes(s.id))
      .filter(filter)
      .map((s) => ({ label: store.displayName(s), description: `${(STATE[s.view] || STATE.idle).group} · ${ago(s.statusSince)}`, detail: s.lastPrompt || '', id: s.id, picked: preselect.includes(s.id) }));
    if (!items.length) {
      vscode.window.showInformationMessage('No other open sessions to choose from.');
      return null;
    }
    const picks = await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true, matchOnDetail: true });
    return picks ? picks.map((x) => x.id) : null;
  }
  async function pickRoom(placeHolder, forSession) {
    const rooms = forSession ? [...model.roomsOf(forSession), store.getRoom(store.ALL)] : model.rooms;
    const items = rooms.map((r) => ({
      label: `$(${r.everyone ? 'broadcast' : 'link'}) ${r.name}`,
      description: r.everyone ? 'every session' : r.members.map(nameOf).join(', '),
      id: r.id,
    }));
    if (forSession) items.push({ label: '$(add) Link with another session…', id: '__link__' });
    else items.push({ label: '$(add) New room…', id: '__new__' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    if (!pick) return null;
    if (pick.id === '__link__') return linkSessions({ sessionId: forSession });
    if (pick.id === '__new__') return newRoom();
    return store.getRoom(pick.id);
  }
  const roomOf = (item) => (item && item.roomId ? store.getRoom(item.roomId) : null);
  const guard = (fn) => async (...a) => {
    try {
      return await fn(...a);
    } catch (e) {
      vscode.window.showErrorMessage(`Switchboard: ${e && e.message}`);
    } finally {
      schedule(50);
    }
  };

  // ── commands ──
  async function linkSessions(item) {
    const start = item && item.sessionId ? [item.sessionId] : [];
    const ids = await pickSessions('Pick the sessions to link (two or more). They will share notes with each other.', start);
    if (!ids) return null;
    if (ids.length < 2) {
      vscode.window.showInformationMessage('Pick at least two sessions to link.');
      return null;
    }
    const suggested = ids.map((id) => store.oneLine(nameOf(id), 22)).join(' + ');
    const name = await vscode.window.showInputBox({ prompt: 'Name for this room', value: suggested });
    if (name === undefined) return null;
    const { room, created } = store.linkSessions(ids, name || suggested);
    vscode.window.showInformationMessage(created ? `Linked ${ids.length} sessions in "${room.name}".` : `Those sessions were already linked in "${room.name}".`);
    return room;
  }
  async function newRoom() {
    const name = await vscode.window.showInputBox({ prompt: 'Room name', placeHolder: 'e.g. Tax + Entrepreneurship' });
    if (!name) return null;
    const ids = (await pickSessions(`Sessions to put in "${name}" (you can add more later)`)) || [];
    return store.createRoom(name, ids);
  }
  async function shareNote(item, forceRoom) {
    let room = forceRoom || roomOf(item);
    if (!room) room = await pickRoom('Share with which sessions?', item && item.sessionId);
    if (!room) return;
    const text = await vscode.window.showInputBox({
      prompt: room.everyone ? 'Note for ALL sessions (each gets it with its next prompt)' : `Note for "${room.name}" (members get it with their next prompt)`,
      placeHolder: 'Facts, decisions, figures… Do not paste passwords or tokens.',
    });
    if (!text || !text.trim()) return;
    store.postNote(room.id, { from: 'user', text });
    vscode.window.setStatusBarMessage(`$(check) Shared to ${room.name}`, 4000);
  }

  const commands = {
    refresh: () => refresh(),
    newSession: () => vscode.commands.executeCommand('claude-vscode.editor.open'),
    openSession: (arg) => openSession(arg),
    jumpNext: async () => {
      const next = model.needing()[0];
      if (!next) return vscode.window.setStatusBarMessage('$(check) No session needs you', 3000);
      await openSession(next.id);
    },
    quickSwitch: async () => {
      const id = await pickSession('Switch to a Claude session');
      if (id) await openSession(id);
    },
    markAllSeen: () => model.sessions.filter(clearsWhenSeen).forEach((s) => store.markSeen(s.id)),
    linkSessions,
    newRoom,
    shareNote,
    broadcast: () => shareNote(null, store.getRoom(store.ALL)),
    addSessionToRoom: async (item) => {
      if (!item || !item.sessionId) return;
      const rooms = model.rooms.filter((r) => !r.everyone && !r.members.includes(item.sessionId));
      const pick = await vscode.window.showQuickPick(
        [...rooms.map((r) => ({ label: r.name, description: r.members.map(nameOf).join(', '), id: r.id })), { label: '$(add) New room…', id: '__new__' }],
        { placeHolder: `Add "${nameOf(item.sessionId)}" to which room?` }
      );
      if (!pick) return;
      if (pick.id === '__new__') {
        const name = await vscode.window.showInputBox({ prompt: 'Room name' });
        if (name) store.createRoom(name, [item.sessionId]);
      } else store.addMember(pick.id, item.sessionId);
    },
    shareLastReply: async (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s) return;
      const turns = s.transcript ? store.recentTurns(s.transcript, { turns: 12, maxChars: 60000 }) : [];
      const last = turns.reverse().find((t) => t.role === 'assistant');
      if (!last) return vscode.window.showInformationMessage('That session has no reply to share yet.');
      const room = await pickRoom(`Share the last reply of "${store.displayName(s)}" with…`, s.id);
      if (!room) return;
      store.postNote(room.id, { from: s.id, kind: 'reply', text: last.text });
      vscode.window.setStatusBarMessage(`$(check) Shared to ${room.name}`, 4000);
    },
    askToShare: async (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s) return;
      const room = await pickRoom(`Where should "${store.displayName(s)}" share its handoff note?`, s.id);
      if (!room) return;
      const target = room.everyone ? 'all' : room.name;
      await openSession(
        s.id,
        `Write a self-contained handoff note of this session's key context for my other sessions: what this is about, decisions made, exact figures and file paths, and open questions. Leave out secrets. Then share it with the Switchboard share tool, to "${target}".`
      );
    },
    shareSelection: async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) return;
      const room = await pickRoom('Share the selection with…');
      if (!room) return;
      const where = `${vscode.workspace.asRelativePath(ed.document.uri)}:${ed.selection.start.line + 1}-${ed.selection.end.line + 1}`;
      store.postNote(room.id, { from: 'user', kind: 'selection', text: `From ${where} (${ed.document.uri.fsPath}):\n\n${ed.document.getText(ed.selection)}` });
      vscode.window.setStatusBarMessage(`$(check) Shared to ${room.name}`, 4000);
    },
    renameSession: async (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s) return;
      const label = await vscode.window.showInputBox({ prompt: 'Name shown in Switchboard (empty = use Claude\'s title)', value: s.label || s.title || '' });
      if (label === undefined) return;
      store.upsertSession(s.id, { label: store.oneLine(label, 60) || null });
    },
    toggleMute: (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s) return;
      store.upsertSession(s.id, { muteAll: !s.muteAll });
      vscode.window.setStatusBarMessage(`"${store.displayName(s)}" ${s.muteAll ? 'receives' : 'no longer receives'} Everyone-room notes`, 4000);
    },
    toggleWatch: (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s) return;
      store.upsertSession(s.id, { watch: !s.watch });
      schedule();
      vscode.window.setStatusBarMessage(s.watch ? `Stopped watching "${store.displayName(s)}"` : `You will be told when "${store.displayName(s)}" finishes`, 4000);
    },
    peekSession: async (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s || !s.transcript) return;
      const turns = store.recentTurns(s.transcript, { turns: 8, maxChars: 16000 });
      const body = [`# ${store.displayName(s)}`, '', ...turns.map((t) => `## ${t.role === 'user' ? 'You' : 'Claude'}\n\n${t.text}\n`)].join('\n');
      const doc = await vscode.workspace.openTextDocument({ content: body, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    copySessionId: (item) => item && item.sessionId && vscode.env.clipboard.writeText(item.sessionId),
    forgetSession: async (item) => {
      const s = item && store.getSession(item.sessionId);
      if (!s) return;
      const ok = await vscode.window.showWarningMessage(
        `Remove "${store.displayName(s)}" from Switchboard? The Claude session and its history are not touched; it reappears if you use it again.`,
        { modal: true },
        'Forget'
      );
      if (ok) store.forgetSession(s.id);
    },
    openNotes: async (item) => {
      const room = roomOf(item) || (await pickRoom('Open notes of which room?'));
      if (!room) return;
      const uri = docs.uri(room);
      try {
        await vscode.commands.executeCommand('markdown.showPreview', uri);
      } catch {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      }
    },
    editPin: async (item) => {
      const room = roomOf(item) || (await pickRoom('Edit the pinned brief of which room?'));
      if (!room) return;
      const file = store.pinFile(room.id);
      if (!fs.existsSync(file)) {
        store.ensure();
        fs.writeFileSync(file, '');
        vscode.window.showInformationMessage(
          `Write the standing context for "${room.name}" in this file and save. Members receive it when they start and whenever it changes. Empty file = no brief.`
        );
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    },
    addToRoom: async (item) => {
      const room = roomOf(item);
      if (!room || room.everyone) return;
      const ids = await pickSessions(`Add sessions to "${room.name}"`, [], (s) => !room.members.includes(s.id));
      for (const id of ids || []) store.addMember(room.id, id);
    },
    removeFromRoom: (item) => item && item.roomId && item.sessionId && store.removeMember(item.roomId, item.sessionId),
    renameRoom: async (item) => {
      const room = roomOf(item);
      if (!room || room.everyone) return;
      const name = await vscode.window.showInputBox({ prompt: 'Room name', value: room.name });
      if (name) store.renameRoom(room.id, name);
    },
    clearNotes: async (item) => {
      const room = roomOf(item);
      if (!room) return;
      const ok = await vscode.window.showWarningMessage(`Delete all notes in "${room.name}"? This cannot be undone.`, { modal: true }, 'Delete notes');
      if (ok) store.clearNotes(room.id);
    },
    deleteRoom: async (item) => {
      const room = roomOf(item);
      if (!room || room.everyone) return;
      const ok = await vscode.window.showWarningMessage(`Delete room "${room.name}" with its notes and pinned brief? The sessions themselves are not touched.`, { modal: true }, 'Delete room');
      if (ok) store.deleteRoom(room.id);
    },
  };
  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`switchboard.${name}`, guard(fn)));
  }

  // ── watch the store; poll as a fallback and to notice processes that died ──
  let watcher = null;
  try {
    watcher = fs.watch(store.home(), { recursive: true }, (_ev, file) => {
      if (file && /\.(tmp|lock)$/.test(String(file))) return;
      schedule();
    });
    watcher.on('error', () => {});
  } catch {
    /* recursive watch is not available everywhere; the poll below covers it */
  }
  const poll = setInterval(() => schedule(0), watcher ? 5000 : 1500);
  context.subscriptions.push(
    { dispose: () => { clearInterval(poll); clearTimeout(timer); if (watcher) watcher.close(); } },
    vscode.window.tabGroups.onDidChangeTabs(seeActive),
    vscode.window.tabGroups.onDidChangeTabGroups(seeActive),
    vscode.window.onDidChangeWindowState(seeActive),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('switchboard') && schedule(0))
  );
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
