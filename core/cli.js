#!/usr/bin/env node
'use strict';
/** Switchboard command line. Works without VS Code: `node cli.js help`. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store.js');

const args = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json' || a === '--all') flags[a.slice(2)] = true;
  else if (a === '--name' || a === '-n') flags[a === '-n' ? 'n' : 'name'] = args[++i];
  else pos.push(a);
}
const cmd = pos.shift() || 'help';
const out = (s) => process.stdout.write(`${s}\n`);
const die = (s) => {
  process.stderr.write(`switchboard: ${s}\n`);
  process.exit(1);
};
const need = (r) => (r.error ? die(r.error) : r.session || r.room);
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
/** same wording as the sidebar: done = finished and not looked at yet */
const shown = (s) => store.viewState(s);

const HELP = `Switchboard — see and connect your Claude Code sessions.

  sessions [--all] [--json]        list sessions (--all adds headless and old ones)
  rooms [--json]                   list rooms and members
  link <session> <session>... [--name <room>]   link sessions in a room
  add <room> <session>             add a session to a room
  remove <room> <session>          take a session out of a room
  delete-room <room>               delete a room and its notes
  share <room|all> <text...>       post a note (use - to read the text from stdin)
  notes <room|all> [-n 20]         show a room's notes
  pin <room|all> <text...>         set the room's pinned brief (empty text removes it)
  peek <session> [-n 6]            last turns of a session
  label <session> <name...>        give a session your own name
  mute <session> | unmute <session>   stop / resume Everyone-room broadcasts for a session
  forget <session>                 remove a session from Switchboard (the Claude session itself is untouched)
  doctor                           check the installation
  home                             print the data folder

Sessions and rooms can be given by name, part of a name, or id prefix.`;

function readText(words) {
  if (words.length === 1 && words[0] === '-') return fs.readFileSync(0, 'utf8');
  return words.join(' ');
}

switch (cmd) {
  case 'sessions': {
    const list = store.listSessions({ includeHeadless: !!flags.all, keepOld: !!flags.all });
    if (flags.json) {
      out(JSON.stringify(list.map((s) => ({ ...s, name: store.displayName(s), rooms: store.roomsFor(s.id).filter((r) => !r.everyone).map((r) => r.name) })), null, 1));
      break;
    }
    if (!list.length) out('No sessions yet. Sessions appear after their next prompt once the hook is installed.');
    for (const s of list) {
      const rooms = store.roomsFor(s.id).filter((r) => !r.everyone).map((r) => r.name);
      out(
        `${shown(s).padEnd(8)} ${s.id.slice(0, 8)}  ${store.clip(store.displayName(s), 44).padEnd(44)} ${ago(s.updatedAt).padStart(4)}` +
          `${rooms.length ? `  [${rooms.join(', ')}]` : ''}${s.attention ? `  ! ${s.attention}` : ''}`
      );
    }
    break;
  }
  case 'rooms': {
    const rooms = store.listRooms();
    if (flags.json) {
      out(JSON.stringify(rooms.map((r) => ({ ...r, pinned: store.getPin(r.id), notes: store.readNotes(r.id).length })), null, 1));
      break;
    }
    for (const r of rooms) {
      const members = r.everyone ? 'every session' : r.members.map((m) => store.displayName(store.getSession(m))).join(', ') || 'no members';
      out(`${r.name} (${r.id}) — ${members} — ${store.readNotes(r.id).length} note(s)${store.getPin(r.id) ? ', pinned brief' : ''}`);
    }
    break;
  }
  case 'link': {
    if (pos.length < 2) die('link needs at least two sessions.');
    const ids = pos.map((q) => need(store.resolveSession(q)).id);
    const { room, created } = store.linkSessions(ids, flags.name);
    out(`${created ? 'Created' : 'Already linked:'} room "${room.name}" (${room.id}).`);
    break;
  }
  case 'add':
  case 'remove': {
    const room = need(store.resolveRoom(pos[0]));
    const s = need(store.resolveSession(pos[1]));
    try {
      if (cmd === 'add') store.addMember(room.id, s.id);
      else store.removeMember(room.id, s.id);
    } catch (e) {
      die(e.message);
    }
    out(`${cmd === 'add' ? 'Added' : 'Removed'} "${store.displayName(s)}" ${cmd === 'add' ? 'to' : 'from'} "${room.name}".`);
    break;
  }
  case 'delete-room': {
    const room = need(store.resolveRoom(pos[0]));
    try {
      store.deleteRoom(room.id);
    } catch (e) {
      die(e.message);
    }
    out(`Deleted room "${room.name}".`);
    break;
  }
  case 'share': {
    const room = need(store.resolveRoom(pos[0]));
    try {
      const note = store.postNote(room.id, { from: 'user', text: readText(pos.slice(1)) });
      out(`Shared to "${room.name}" (note ${note.id}). Sessions get it with their next prompt.`);
    } catch (e) {
      die(e.message);
    }
    break;
  }
  case 'notes': {
    const room = need(store.resolveRoom(pos[0]));
    const pin = store.getPin(room.id);
    if (pin) out(`[Pinned brief]\n${pin}\n`);
    const notes = store.readNotes(room.id, { limit: Number(flags.n) || 20 });
    if (!notes.length) out('No notes.');
    for (const n of notes) out(`[${store.when(n.ts)} · ${n.fromName}]\n${n.text}\n`);
    break;
  }
  case 'pin': {
    const room = need(store.resolveRoom(pos[0]));
    const saved = store.setPin(room.id, readText(pos.slice(1)));
    out(saved ? `Pinned brief saved for "${room.name}".` : `Pinned brief removed from "${room.name}".`);
    break;
  }
  case 'peek': {
    const s = need(store.resolveSession(pos[0]));
    if (!s.transcript) die('No transcript recorded for that session.');
    for (const t of store.recentTurns(s.transcript, { turns: Number(flags.n) || 6 })) out(`### ${t.role === 'user' ? 'You' : 'Claude'}\n${t.text}\n`);
    break;
  }
  case 'label': {
    const s = need(store.resolveSession(pos[0]));
    store.upsertSession(s.id, { label: store.oneLine(pos.slice(1).join(' '), 60) || null });
    out('Label saved.');
    break;
  }
  case 'mute':
  case 'unmute': {
    const s = need(store.resolveSession(pos[0]));
    store.upsertSession(s.id, { muteAll: cmd === 'mute' });
    out(`"${store.displayName(s)}" ${cmd === 'mute' ? 'no longer receives' : 'receives'} Everyone-room notes.`);
    break;
  }
  case 'forget': {
    const s = need(store.resolveSession(pos[0]));
    store.forgetSession(s.id);
    out(`Forgot "${store.displayName(s)}".`);
    break;
  }
  case 'home':
    out(store.home());
    break;
  case 'doctor': {
    const ok = (b, msg) => out(`${b ? 'ok  ' : 'FAIL'} ${msg}`);
    store.ensure();
    ok(true, `data folder: ${store.home()}`);
    let settings = null;
    const sf = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
    try {
      settings = JSON.parse(fs.readFileSync(sf, 'utf8'));
    } catch {}
    const events = settings && settings.hooks ? Object.keys(settings.hooks).filter((e) => JSON.stringify(settings.hooks[e]).includes('switchboard')) : [];
    ok(events.length >= 5, `hooks in ${sf}: ${events.join(', ') || 'none'}`);
    const sessions = store.listSessions({ includeHeadless: true });
    ok(sessions.length > 0, `${sessions.length} session(s) registered (sessions started before the install appear after a restart)`);
    ok(Number(process.versions.node.split('.')[0]) >= 18, `node ${process.versions.node}`);
    break;
  }
  default:
    out(HELP);
}
