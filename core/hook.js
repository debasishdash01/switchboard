#!/usr/bin/env node
'use strict';
/**
 * Switchboard hook for Claude Code. One script handles every event; Claude passes the event as JSON on stdin.
 *
 *   SessionStart       register the session; hand over pinned briefs and unread shared notes
 *   UserPromptSubmit   status -> working; hand over unread shared notes
 *   PermissionRequest  a permission dialog is about to show -> "blocked"
 *   Notification       permission / question prompts -> status "blocked" (needs you)
 *   PreToolUse         only for AskUserQuestion / ExitPlanMode -> "blocked"
 *   PostToolUse        a tool ran, so nothing is blocking any more -> "working"
 *   Stop               status -> "done" (finished, not yet looked at)
 *   StopFailure        the turn died on an error -> "blocked"
 *   SessionEnd         status -> "closed"
 *
 * Set SWITCHBOARD_HOOKS_DISABLED=1 to turn the hook into a no-op.
 *
 * Rules: never block Claude, never fail loudly. Any error ends in exit 0 with no output.
 */
const HARD_LIMIT_MS = 2500;
const timer = setTimeout(() => process.exit(0), HARD_LIMIT_MS);

function main(raw) {
  const store = require('./store.js');
  let input;
  try {
    // Windows shells can prepend a byte-order mark (or its mojibake form) to stdin.
    input = JSON.parse(raw.replace(/^\uFEFF/, '').replace(/^\u00EF\u00BB\u00BF/, ''));
  } catch {
    return;
  }
  const sid = input.session_id;
  const event = input.hook_event_name;
  if (!sid || !event) return;
  // Events raised inside a subagent carry agent_id. They must not change the parent session's status
  // (herdr and cmux both hit "subagent finished, so the pane looks idle/blocked" bugs).
  if (input.agent_id && event !== 'SessionStart') return;

  const env = process.env;
  const pid = Number(env.CLAUDE_PID) || undefined;
  const base = {};
  if (input.cwd) base.cwd = input.cwd;
  if (input.transcript_path) base.transcript = input.transcript_path;
  if (pid) base.pid = pid;
  if (env.CLAUDE_CODE_ENTRYPOINT) base.entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
  // Unattended runs (claude -p, SDK, workflows) are recorded but hidden from the sidebar by default.
  base.headless = env.CLAUDE_CODE_SESSION_ATTENDED === '0' || /^sdk/.test(env.CLAUDE_CODE_ENTRYPOINT || '');

  const emit = (text) => {
    if (!text) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
  };

  switch (event) {
    case 'SessionStart': {
      const prev = store.getSession(sid);
      const patch = { ...base, attention: null };
      if (!prev || prev.status === 'closed') {
        patch.status = 'idle';
        patch.seen = true;
      }
      store.upsertSession(sid, patch);
      store.recordPid(pid, sid);
      if (Math.random() < 0.1) store.prunePids();
      const fresh = input.source !== 'resume'; // startup, clear, compact: context is empty again
      emit(store.collectInjection(sid, { fresh }).text);
      break;
    }
    case 'UserPromptSubmit': {
      const prev = store.getSession(sid);
      const prompt = store.oneLine(input.prompt, 240);
      const patch = { ...base, status: 'working', seen: true, attention: null, lastPrompt: prompt, bg: 0 };
      if (!prev || !prev.firstPrompt) patch.firstPrompt = prompt;
      store.upsertSession(sid, patch);
      store.recordPid(pid, sid);
      emit(store.collectInjection(sid, { fresh: false }).text);
      break;
    }
    case 'Notification': {
      const type = String(input.notification_type || '');
      const msg = store.oneLine(input.message, 200);
      const blocking = /permission|elicitation|question/i.test(type) || (!type && /permission|approv|needs your|waiting for your/i.test(msg));
      if (blocking) store.upsertSession(sid, { ...base, status: 'blocked', seen: false, attention: msg || 'Waiting for you' });
      break;
    }
    case 'PermissionRequest': {
      // Fires when Claude is about to show a permission dialog. We print nothing, so the dialog appears as usual.
      const tool = String(input.tool_name || 'a tool');
      store.upsertSession(sid, { ...base, status: 'blocked', seen: false, attention: 'Needs your permission: ' + tool });
      break;
    }
    case 'PreToolUse': {
      const tool = String(input.tool_name || '');
      if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') {
        const why = tool === 'AskUserQuestion' ? 'Asking you a question' : 'Plan ready for your approval';
        store.upsertSession(sid, { ...base, status: 'blocked', seen: false, attention: why });
      }
      break;
    }
    case 'PostToolUse': {
      // Only ever clears "blocked". It must not turn a finished session back into a working one.
      const prev = store.getSession(sid);
      if (prev && prev.status === 'blocked') store.upsertSession(sid, { status: 'working', attention: null, seen: true });
      break;
    }
    case 'Stop': {
      const bg = Array.isArray(input.background_tasks) ? input.background_tasks.length : 0;
      const patch = {
        ...base,
        // With background work still running the turn is not really over.
        status: bg ? 'working' : 'done',
        seen: bg ? true : false,
        bg,
        attention: null,
        lastReply: store.oneLine(input.last_assistant_message, 400),
      };
      const title = store.titleFromTranscript(input.transcript_path);
      if (title) patch.title = title;
      store.upsertSession(sid, patch);
      break;
    }
    case 'StopFailure': {
      // The turn ended on an API error instead of a normal Stop.
      store.upsertSession(sid, { ...base, status: 'blocked', seen: false, attention: 'Stopped on an error' });
      break;
    }
    case 'SessionEnd': {
      store.upsertSession(sid, { status: 'closed', attention: null, closedBy: input.reason || 'ended' });
      break;
    }
    default:
      break;
  }
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  try {
    if (process.env.SWITCHBOARD_HOOKS_DISABLED !== '1') main(data);
  } catch (e) {
    if (process.env.SWITCHBOARD_DEBUG) process.stderr.write(`switchboard hook: ${e && e.stack}\n`);
  }
  clearTimeout(timer);
});
process.stdin.on('error', () => process.exit(0));
