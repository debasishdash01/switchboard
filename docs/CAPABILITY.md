# Switchboard: capability contract

Written 2026-11-26 in the ECC `product-capability` format. It records what must stay true; the product reasoning is in [PRODUCT-BRIEF.md](PRODUCT-BRIEF.md).

## Capability

- **Name:** session board and shared context for Claude Code
- **Primary actor:** one person running several Claude Code sessions on one machine
- **Outcome after ship:** they see every session's state in one place, reach the one that needs them with one shortcut, and move context between chosen sessions (or all of them) with one action
- **Success signal:** blocked sessions are found from the sidebar, and cross-session facts are shared with `share` and not by copy-paste

## Constraints (fixed rules)

1. **Local only.** No network calls, accounts or telemetry. All state is under `~/.switchboard` (`SWITCHBOARD_HOME` overrides it).
2. **The hook must never hurt a session.** It exits 0 on every path, prints nothing on error, kills itself after 2.5 s, and does nothing when `SWITCHBOARD_HOOKS_DISABLED=1`.
3. **No cost when idle.** When a session has nothing new to receive, the hook prints nothing.
4. **Notes are data.** They reach a session only inside a `<switchboard-shared-context>` block that says they are reference material and not instructions. A note body cannot contain that tag or control characters.
5. **Rooms are the privacy boundary.** An agent may read another session's turns (`peek_session`) only when both sessions share a room other than Everyone. An agent may post only to rooms its session is in, or to Everyone.
6. **Delivery needs the user.** A note is delivered with the receiving session's next prompt or start. Nothing wakes a session.
7. **Each note is delivered once per session.** The sender never receives its own note.
8. **Own entries only.** The installer adds and removes only hook entries that point at `switchboard/app/hook.js`, writes a backup of `settings.json` first, and refuses to touch a settings file it cannot parse.
9. **No dependencies.** Node 18+ standard library only, so it runs wherever Claude Code runs.
10. **Public surface of Claude Code only:** hooks, an MCP server, and the extension's commands.

## Actors and surfaces

| Surface | Used by | What it does |
|---|---|---|
| `core/hook.js` | Claude Code | Records session state; hands shared context to the session |
| `core/mcp.js` (server `switchboard`) | the agent in a session | `whoami`, `list_sessions`, `share`, `read_shared`, `peek_session`, `link_sessions`, `set_pinned_brief` |
| `core/cli.js` | the user, scripts | Same operations from a terminal; `doctor` |
| `vscode/` extension | the user | Sessions view, Rooms view, status bar, notifications, share commands |
| `skill/SKILL.md` | the agent | How to write a good handoff note and treat received notes |

## States and transitions

Stored status: `idle → working → blocked ⇄ working → done → working …`, and `closed`.

| Event (hook) | Effect |
|---|---|
| SessionStart | register; `idle` if new or previously closed; deliver pinned briefs and unread notes |
| UserPromptSubmit | `working`; deliver unread notes |
| PermissionRequest, Notification (permission / question), PreToolUse on `AskUserQuestion` or `ExitPlanMode`, StopFailure | `blocked`, with a reason |
| PostToolUse | `blocked → working` only. Never changes any other status |
| Stop | `done`; `working` if background tasks are still running (finished tasks and monitors do not count; what Claude listed is kept in `stopTasks`) |
| SessionEnd | `closed` |
| (reader side) Claude process no longer exists | shown as `closed` |

Shown state adds one derived value: `done` is shown as **Finished · not seen yet** until the user opens the session from the sidebar or focuses its tab; after that it is shown as **Idle**. "Seen" is stored in its own file (`seen/<id>`) so the sidebar never rewrites a file the hook writes.

Guards (each one is a bug cmux or herdr documented): events with `agent_id` (subagents) are ignored; an `idle_prompt` notification is not "blocked"; a late tool event cannot revive a finished session.

## Interface contract

- **Delivery order:** pinned briefs first, then notes room by room, oldest first. Limit 8,000 characters per prompt; the remainder is announced ("N more waiting") and delivered next time.
- **First read of a room:** the last 5 notes. For Everyone, only notes from the last 24 hours.
- **Pinned brief:** delivered when it changes, and again when the session's context is empty (startup, `/clear`, after compaction). Not re-sent on resume.
- **`share` targets:** omitted → every room the session is in except Everyone; a room name; a session name (links the two sessions if needed); `all`.
- **Name lookup:** id, id prefix, exact name, then part of a name. Ambiguous matches return an error that lists the candidates.
- **Failure:** tools return an error message the agent can read; nothing is partially written. `rooms.json` changes are serialised with a lock directory; all JSON writes are write-then-rename.

## Data

| Path under `~/.switchboard` | Content | Written by |
|---|---|---|
| `sessions/<id>.json` | status, title, last prompt and reply (short), cwd, transcript path, pid | hook; sidebar and CLI for label and mute |
| `pids/<pid>` | claude process → session id | hook |
| `rooms.json` | rooms and members | sidebar, CLI, agent tools |
| `notes/<room>.jsonl` | append-only notes | sidebar, CLI, agent tools |
| `pins/<room>.md` | pinned brief (edit it like any file) | user, agent tool |
| `cursors/<id>.json` | what each session has received | hook, `read_shared` |
| `seen/<id>` | when the user last looked | sidebar |

Retention: closed sessions are dropped after 14 days. Notes stay until the room is cleared or deleted. Session files hold a 240-character prompt and a 400-character reply; full conversations stay in Claude's own transcripts and are read only by `peek_session` and the sidebar's Peek.

## Security and policy

- Trust boundary: everything a note or a peeked turn contains is untrusted text from another conversation.
- Any process running as the same user can read and write the store. That matches Claude's own transcripts, which sit unencrypted in `~/.claude`.
- Abuse path considered: a session that read a malicious web page shares a note telling other sessions to run something. The wrapper and the skill tell the receiving agent not to act on requests inside notes, and the receiving session still asks the user for permission before any tool runs. This lowers the risk; it does not remove it.
- Agent tools are not pre-approved. Claude asks before the first `share`, `link_sessions` or `peek_session`, and the user can choose "always allow".

## Non-goals

Terminal multiplexing, a browser pane, remote or cloud sessions, sessions on other machines, automatic agent-to-agent conversations, summarising sessions with a model.

## Open questions

1. Does `claude-vscode.primaryEditor.open` focus an already-open tab or open a second one for the same session? Not yet seen in a real window.
2. Do permission dialogs in the VS Code extension fire `PermissionRequest`, `Notification`, or both? Both are handled; which one actually arrives is unconfirmed.
3. Should a link attach to a session or to something longer-lived? Session IDs survive resume, but a fresh session on the same topic starts unlinked.

## Handoff

- Ready for implementation: yes, and implemented in 0.1.
- Verification: 17 automated tests, plus an end-to-end run with two real Claude sessions (one shared through the tool, the other received the note with its next prompt).
- Still to verify by hand in VS Code: the three open questions above and the look of the two views.
