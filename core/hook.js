#!/usr/bin/env node
'use strict';
/**
 * Switchboard hook for Claude Code. One script handles every event; Claude passes the event as JSON on stdin.
 *
 *   SessionStart       register the session; hand over pinned briefs and unread shared notes
 *   UserPromptSubmit   a turn starts -> "working"; hand over unread shared notes
 *                      (if another tool's hook refuses the prompt, no turn starts and no Stop follows;
 *                      readers catch that from the transcript, see store.applyRefusal)
 *   PermissionRequest  a permission dialog is about to show -> "blocked", also when a subagent asks
 *   PreToolUse         only for AskUserQuestion / ExitPlanMode -> "blocked"
 *   Notification       permission / MCP form reminders -> "blocked" if nothing is known to block yet
 *   PostToolBatch      every call of a batch has an answer, so what that batch waited for is over
 *   PostToolUse        not registered any more; handled for sessions that started before the change
 *   Stop               the turn is over -> "done", or "working" while background work goes on
 *   StopFailure        the turn died on an error -> "blocked"
 *   SessionEnd         status -> "closed"
 *
 * What a session shows is worked out from three stored things, never from the last event alone:
 *   under    the status with nothing blocking: idle, working, done or closed
 *   blocks   what is waiting for the user, one entry per asker: "main", "a:<agent id>" for a subagent,
 *            "notice" for a reminder with no known asker, "error" for a turn that died
 *   turnAt   when the newest turn event happened (prompt, Stop, start or end of the session)
 * Most hooks run in the background, so they can finish in a different order than their events happened.
 * Every event therefore carries the time it happened, and one that is older than what it would change
 * is dropped: a late Stop does not finish a turn that started after it, a late batch does not clear a
 * dialog that opened after it. Where an event names its turn (prompt_id), that decides before the clock
 * does. One order can be told from neither: a request that lands after the batch that already answered
 * it. So the installer registers the events that raise a dialog as hooks Claude waits for (see install.js).
 *
 * Set SWITCHBOARD_HOOKS_DISABLED=1 to turn the hook into a no-op.
 *
 * Rules: never block Claude, never fail loudly. Any error ends in exit 0 with no output.
 */
const HARD_LIMIT_MS = 2500;

// Final statuses of a background task. Anything else (running, pending, no status at all) is still going.
const FINISHED = /^(completed?|done|finished|succeeded|success|failed|failure|error(ed)?|killed|stopped|cancell?ed|aborted|timed[_ -]?out|timeout|exited|closed)$/i;
const inFlight = (task) => !FINISHED.test(String((task && task.status) || '').trim());
// A monitor only watches for something. Claude attaches one to a session that publishes an artifact
// ("live updates for artifact ..."), and it stays "running" for as long as the session is open.
const isWatcher = (task) => /monitor/i.test(String((task && task.type) || ''));
// Work in progress: Claude will come back with a result. A watcher or a finished task is not that.
const isWork = (task) => inFlight(task) && !isWatcher(task);

const AGENT = 'a:'; // block keys of subagents start with this
const NOTICE = 'notice';
// Inside a subagent, only what asks for the user and what ends that asking concerns the parent session.
// Its other events must not move the parent's status (herdr and cmux both hit "subagent finished, so the
// pane looks idle" bugs).
const FROM_SUBAGENT = new Set(['SessionStart', 'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolBatch']);
// Notification types that mean an MCP server's form is waiting, and those that mean one was just answered.
const FORM = /^(elicitation_dialog|elicitation_url_dialog)$/;
const ANSWERED = /^(elicitation_complete|elicitation_response)$/;
// A turn Claude starts by itself when a background task reports back. Nobody typed it.
const SELF_STARTED = /^\s*<task-notification\b/;
// A tool that began this long after a dialog opened began after the dialog was answered.
const AFTER_MS = 500;

/** The stored state, also for records written before `under` and `blocks` existed. */
function stateOf(rec) {
  const blocks = {};
  if (rec.blocks && typeof rec.blocks === 'object') {
    for (const [k, b] of Object.entries(rec.blocks)) if (b && typeof b === 'object') blocks[k] = b;
  } else if (rec.status === 'blocked') {
    blocks.main = { at: rec.statusSince || 0, why: rec.attention || 'Waiting for you' };
  }
  return { under: rec.under || (rec.status === 'blocked' ? 'working' : rec.status || 'idle'), blocks, turnAt: rec.turnAt || 0 };
}

/** The record after an event: status, reason and "seen" follow from the state. */
function settled(rec, st, at, extra) {
  const keys = Object.keys(st.blocks).sort((a, b) => (st.blocks[a].at || 0) - (st.blocks[b].at || 0));
  const status = st.under === 'closed' ? 'closed' : keys.length ? 'blocked' : st.under;
  const next = { ...rec, ...extra, under: st.under, blocks: st.under === 'closed' ? {} : st.blocks, turnAt: st.turnAt, status };
  // The oldest thing waiting is named; the rest is counted.
  next.attention = status === 'blocked' ? String(st.blocks[keys[0]].why || 'Waiting for you') + (keys.length > 1 ? ` (+${keys.length - 1} more)` : '') : null;
  next.seen = status !== 'blocked' && status !== 'done';
  if (status !== rec.status && !(extra && extra.statusSince)) next.statusSince = at;
  return next;
}

/**
 * Handle one event. `opts.at` is when the event happened, `opts.env` the environment Claude gave the hook.
 * Returns the text to hand to the session ('' when there is none).
 */
function handle(input, opts = {}) {
  const store = require('./store.js');
  const env = opts.env || process.env;
  const at = opts.at || Date.now();
  const sid = input && input.session_id;
  const event = input && input.hook_event_name;
  if (!sid || !event) return '';
  const agent = input.agent_id ? String(input.agent_id) : '';
  if (agent && !FROM_SUBAGENT.has(event)) return '';
  const key = agent && event !== 'SessionStart' ? AGENT + agent : 'main';

  const pid = Number(env.CLAUDE_PID) || undefined;
  const base = {};
  // A subagent can work in another folder (a worktree); the session's own folder is not that.
  if (key === 'main') {
    if (input.cwd) base.cwd = input.cwd;
    if (input.transcript_path) base.transcript = input.transcript_path;
    if (pid) base.pid = pid;
    if (env.CLAUDE_CODE_ENTRYPOINT) base.entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
    // Unattended runs (claude -p, SDK, workflows) are recorded but hidden from the sidebar by default.
    base.headless = env.CLAUDE_CODE_SESSION_ATTENDED === '0' || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '');
  }
  const blank = () => ({ id: sid, status: 'idle', seen: true });
  const sig = (toolInput) => {
    try {
      return toolInput == null ? '' : store.hash(JSON.stringify(toolInput));
    } catch {
      return '';
    }
  };
  // A title the user set arrives with the event; Claude's own title is in the transcript.
  const titleNow = () => store.oneLine(input.session_title, 120) || store.titleFromTranscript(input.transcript_path);
  // Every event names the turn it belongs to (prompt_id). The times of two hooks started a few
  // milliseconds apart can come out in the wrong order; the turn they belong to cannot.
  const turn = input.prompt_id ? String(input.prompt_id) : '';
  const sameTurn = (rec) => !!turn && rec.promptId === turn;
  const earlierTurn = (rec) => !!turn && rec.promptId !== turn && Array.isArray(rec.pastPromptIds) && rec.pastPromptIds.includes(turn);
  /** True when the turn this event belongs to is over, or a newer one has begun. */
  const late = (rec, st) => earlierTurn(rec) || (!sameTurn(rec) && at < st.turnAt);

  /** Something starts waiting for the user. */
  const raise = (k, block) =>
    store.updateSession(sid, (cur) => {
      // No record yet (the session is older than the install): a tool is being called, so a turn is running.
      const rec = cur || { ...blank(), status: 'working' };
      const st = stateOf(rec);
      if (st.under === 'closed') return null;
      if (k.startsWith(AGENT)) {
        // A subagent in the background outlives the turn. Its request is over only if it was raised
        // before the last Stop that found nothing running.
        if (block.at < (rec.quietAt || 0)) return null;
      } else if (earlierTurn(rec) || block.at < st.turnAt) return null; // its turn ended, or a new one began
      st.blocks[k] = block;
      return settled(rec, st, at, base);
    });
  /** Drop what is waiting where pick(key, block) says so. Never touches anything raised after this event. */
  const resolve = (pick) => {
    const peek = store.getSession(sid);
    if (!peek || peek.status !== 'blocked') return; // the usual case: nothing to clear, so no lock and no write
    store.updateSession(sid, (cur) => {
      if (!cur) return null;
      const st = stateOf(cur);
      let dropped = 0;
      for (const k of Object.keys(st.blocks)) {
        if ((st.blocks[k].at || 0) <= at && pick(k, st.blocks[k])) {
          delete st.blocks[k];
          dropped++;
        }
      }
      return dropped ? settled(cur, st, at, { clearedAt: Math.max(at, cur.clearedAt || 0) }) : null;
    });
  };

  switch (event) {
    case 'SessionStart': {
      const title = titleNow();
      store.updateSession(sid, (cur) => {
        const rec = cur || blank();
        const st = stateOf(rec);
        // A Claude process that has just started is not in the middle of a turn. A record that says so
        // was left by a process that died without SessionEnd (a crash, a power cut).
        const reborn =
          cur && pid && cur.pid && cur.pid !== pid && !store.pidAlive(cur.pid) && /^(startup|resume)$/.test(String(input.source || '')) &&
          (st.under === 'working' || Object.keys(st.blocks).length > 0);
        if (!cur || st.under === 'closed' || reborn) {
          st.under = 'idle';
          st.blocks = {};
          st.turnAt = at;
        }
        return settled(rec, st, at, title ? { ...base, title } : base);
      });
      store.recordPid(pid, sid);
      if (Math.random() < 0.1) store.prunePids();
      const fresh = input.source !== 'resume'; // startup, clear, compact: context is empty again
      return store.collectInjection(sid, { fresh }).text;
    }
    case 'UserPromptSubmit': {
      const raw = String(input.prompt == null ? '' : input.prompt);
      const typed = !SELF_STARTED.test(raw);
      const prompt = store.oneLine(raw, 240);
      const title = titleNow();
      store.updateSession(sid, (cur) => {
        const rec = cur || blank();
        // What the session was really doing when this prompt arrived: a hook may have refused its last one.
        const was = store.applyRefusal({ ...rec });
        const st = stateOf(rec);
        st.under = 'working';
        st.turnAt = at;
        // A new turn ends whatever the last one waited for. A subagent still running in the background
        // may still be waiting, unless the user is here typing.
        for (const k of Object.keys(st.blocks)) if (typed || !k.startsWith(AGENT)) delete st.blocks[k];
        const extra = {
          ...base,
          bg: 0,
          // Another hook may refuse this prompt, and we cannot see that from here. These two let a reader
          // tell later (store.applyRefusal): which prompt a refusal notice belongs to, and whether
          // background work was running, which a refused prompt does not stop.
          promptAt: at,
          bgBefore: was.status === 'working' ? was.bg || 0 : 0,
          // "Working" counts from this prompt. The status may have been "working" already (after a refused
          // prompt, an interrupted turn, or with background work), and its start would not move by itself.
          statusSince: at,
        };
        if (turn && turn !== rec.promptId) {
          extra.promptId = turn;
          extra.pastPromptIds = [rec.promptId, ...(Array.isArray(rec.pastPromptIds) ? rec.pastPromptIds : [])].filter(Boolean).slice(0, 4);
        }
        if (typed) {
          extra.lastPrompt = prompt;
          if (!rec.firstPrompt) extra.firstPrompt = prompt;
        }
        if (title) extra.title = title;
        return settled(rec, st, at, extra);
      });
      store.recordPid(pid, sid);
      return store.collectInjection(sid, { fresh: false }).text;
    }
    case 'PermissionRequest':
    case 'PreToolUse': {
      // PermissionRequest fires when Claude is about to show a permission dialog. We print nothing, so the
      // dialog appears as usual. It carries no tool call id, so the call is recognised later by its input.
      const tool = String(input.tool_name || '');
      let why;
      if (tool === 'AskUserQuestion') why = 'Asking you a question';
      else if (tool === 'ExitPlanMode') why = 'Plan ready for your approval';
      else if (event === 'PermissionRequest') why = `Needs your permission: ${tool || 'a tool'}`;
      else break;
      if (agent) why += ' (asked by a subagent)';
      raise(key, { at, why, tool, sig: sig(input.tool_input) });
      break;
    }
    case 'Notification': {
      const type = String(input.notification_type || '');
      if (ANSWERED.test(type)) {
        resolve((k) => k === NOTICE);
        break;
      }
      const msg = store.oneLine(input.message, 200);
      const permission = type === 'permission_prompt' || (!type && /permission|approv|needs your|waiting for your/i.test(msg));
      if (!permission && !FORM.test(type)) break;
      store.updateSession(sid, (cur) => {
        const rec = cur || blank();
        const st = stateOf(rec);
        if (st.under === 'closed' || at < st.turnAt) return null;
        // Claude sends the permission reminder a few seconds into a dialog. PermissionRequest has
        // reported that dialog already, or it was answered after the reminder was sent: nothing to add.
        // An MCP form has no other event, so its reminder always counts.
        if (permission && (Object.keys(st.blocks).some((k) => k !== NOTICE && k !== 'error') || at <= (rec.clearedAt || 0))) return null;
        st.blocks[NOTICE] = { at, why: msg || 'Waiting for you' };
        return settled(rec, st, at, base);
      });
      break;
    }
    case 'PostToolBatch': {
      // Every call of the batch has its answer (it ran, failed or was refused), so no dialog of this
      // asker is open any more. A tool that finishes while a dialog for another call of the same batch
      // is still open does not get here: that is why this event is used and not PostToolUse.
      // A reminder with no known asker is taken to be the session's own, not a subagent's.
      resolve((k) => k === key || (key === 'main' && k === NOTICE));
      break;
    }
    case 'PostToolUse': {
      // One finished tool says less: another call of the same batch can still be waiting for the user.
      const tool = String(input.tool_name || '');
      const called = sig(input.tool_input);
      const took = Number(input.duration_ms);
      const began = Number.isFinite(took) ? at - took : null;
      // The Agent tool returning means that subagent is through (one sent to the background returns at
      // once, before it can have asked for anything). Without PostToolBatch nothing else says so when the
      // subagent's last call was refused.
      const res = input.tool_response;
      const ended = key === 'main' && (tool === 'Agent' || tool === 'Task') && res && typeof res === 'object' && res.agentId ? AGENT + String(res.agentId) : '';
      resolve((k, b) => {
        if (ended && k === ended) return true;
        if (k !== key && !(key === 'main' && k === NOTICE)) return false;
        if (b.tool && b.tool === tool && (!b.sig || b.sig === called)) return true; // the call that was waiting has run
        if (began !== null) return began > (b.at || 0) + AFTER_MS; // it began after the dialog opened, so the dialog was answered
        return !b.tool; // nothing to compare: as before, a finished tool means nothing is waiting
      });
      break;
    }
    case 'Stop': {
      const listed = Array.isArray(input.background_tasks) ? input.background_tasks.filter((t) => t && typeof t === 'object') : [];
      // Only real work counts. Counting every listed task left a session on "working" for good once it
      // had published an artifact, because the artifact's live-update monitor never ends.
      const bg = listed.filter(isWork).length;
      const title = store.titleFromTranscript(input.transcript_path);
      store.updateSession(sid, (cur) => {
        const rec = cur || blank();
        const st = stateOf(rec);
        const extra = { ...base };
        if (title) extra.title = title;
        if (at >= (rec.replyAt || 0)) {
          extra.lastReply = store.oneLine(input.last_assistant_message, 400);
          extra.replyAt = at;
        }
        // A newer prompt is already recorded, or the session has ended: this Stop belongs to a turn
        // before that. It must not finish the turn that is running, nor reopen a closed session.
        if (st.under === 'closed' || late(rec, st)) return { ...rec, ...extra };
        // With background work still running the turn is not really over.
        st.under = bg ? 'working' : 'done';
        st.turnAt = at;
        // The turn's own dialogs are gone. A subagent in the background can still be waiting; when
        // nothing is running, nothing is.
        for (const k of Object.keys(st.blocks)) if (!bg || !k.startsWith(AGENT)) delete st.blocks[k];
        extra.bg = bg;
        extra.watching = listed.filter((t) => inFlight(t) && isWatcher(t)).length;
        // What Claude listed at this Stop, kept until the next Stop so a wrong status can be explained.
        extra.stopTasks = listed.slice(0, 8).map((t) => ({
          id: store.oneLine(t.id, 40),
          type: store.oneLine(t.type, 30),
          status: store.oneLine(t.status, 30),
          what: store.oneLine(t.command || t.description || t.name || t.agent_type || '', 80),
          counted: isWork(t),
        }));
        if (!bg) extra.quietAt = at;
        return settled(rec, st, at, extra);
      });
      break;
    }
    case 'StopFailure': {
      // The turn ended on an API error instead of a normal Stop.
      const kind = store.oneLine(input.error, 40);
      store.updateSession(sid, (cur) => {
        const rec = cur || blank();
        const st = stateOf(rec);
        if (st.under === 'closed' || late(rec, st)) return null;
        st.under = 'done';
        st.turnAt = at;
        for (const k of Object.keys(st.blocks)) if (!k.startsWith(AGENT)) delete st.blocks[k];
        st.blocks.error = { at, why: kind ? `Stopped on an error: ${kind}` : 'Stopped on an error' };
        return settled(rec, st, at, base);
      });
      break;
    }
    case 'SessionEnd': {
      store.updateSession(sid, (cur) => {
        const rec = cur || blank();
        const st = stateOf(rec);
        st.under = 'closed';
        st.turnAt = at;
        return settled(rec, st, at, { closedBy: input.reason || 'ended' });
      });
      break;
    }
    default:
      break;
  }
  return '';
}

if (require.main === module) {
  const timer = setTimeout(() => process.exit(0), HARD_LIMIT_MS);
  // When Claude started this hook, which is when the event happened. Hooks for one event start together.
  const started = Date.now() - Math.round(process.uptime() * 1000);
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    try {
      if (process.env.SWITCHBOARD_HOOKS_DISABLED !== '1') {
        // Windows shells can prepend a byte-order mark (or its mojibake form) to stdin.
        const input = JSON.parse(data.replace(/^﻿/, '').replace(/^ï»¿/, ''));
        const text = handle(input, { at: started });
        if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text } }));
      }
    } catch (e) {
      if (process.env.SWITCHBOARD_DEBUG) process.stderr.write(`switchboard hook: ${e && e.stack}\n`);
    }
    clearTimeout(timer);
  });
  process.stdin.on('error', () => process.exit(0));
}

module.exports = { handle };
