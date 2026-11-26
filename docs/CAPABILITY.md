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

The status is not taken from the last event. It follows from three stored things:

- `under`: the status with nothing waiting for the user (`idle`, `working`, `done`, `closed`).
- `blocks`: what is waiting for the user, one entry per asker, each with the time it was raised and a reason. Askers: `main` (the session's own agent), `a:<agent id>` (a subagent), `notice` (a reminder with no known asker), `error` (a turn that died).
- `turnAt`: when the newest turn event happened (a prompt, a Stop, the start or end of the session).

`status` is `blocked` while `blocks` has an entry, otherwise `under`. The reason shown is the oldest entry's, with `(+N more)` when there are several.

| Event (hook) | Effect |
|---|---|
| SessionStart | register; `idle` if new or previously closed, or if the record says working / blocked but was left by a process that no longer exists (a crash or a power cut: no Stop and no SessionEnd were sent). Reads the title. Delivers pinned briefs and unread notes |
| UserPromptSubmit | `under = working`; ends every non-subagent block; a prompt the user typed ends subagent blocks too. Reads the title. Delivers unread notes. A turn Claude starts by itself (the prompt is a `<task-notification>`: a background task reporting back) does not replace the stored last prompt |
| PermissionRequest; PreToolUse on `AskUserQuestion` or `ExitPlanMode` | adds a block for its asker. Also when the asker is a subagent (the event then carries `agent_id`) |
| Notification `permission_prompt` | a reminder Claude sends a few seconds into a permission dialog. Adds the `notice` block only if no dialog is known and none was answered since it was sent |
| Notification `elicitation_dialog`, `elicitation_url_dialog` | an MCP server's form is waiting; it has no other event. Adds the `notice` block |
| Notification `elicitation_complete`, `elicitation_response` | ends the `notice` block |
| PostToolBatch | every call of a batch has its answer: ends the block of that batch's asker. The session's own batch also ends `notice`; a subagent's does not |
| PostToolUse (no longer registered; sessions started before the change still send it) | ends its asker's block only if this is the call that waited (same tool and input), or the tool began more than 0.5 s after the block was raised |
| Stop | `under = done`, or `working` if background tasks are still running (finished tasks and monitors do not count; what Claude listed is kept in `stopTasks`). Ends non-subagent blocks; ends subagent blocks too when nothing is running |
| StopFailure | `under = done` and an `error` block, which the next prompt ends |
| SessionEnd | `closed`. Only a SessionStart reopens a closed session |
| (reader side) Claude process no longer exists | shown as `closed` |
| (reader side) stored `working`, and the newest thing in the transcript is Claude's notice that a UserPromptSubmit hook refused the prompt | shown as `blocked` with that hook's reason, until the user has looked at the session, then `idle`; stays `working` if background work was running when the prompt came in |
| (reader side) no stored title | the title in the transcript is shown |

**Order of events.** The hooks for Notification, PreToolUse, PostToolBatch, Stop and StopFailure run in the background: Claude starts the process and goes on, so two hooks can finish in a different order than their events happened. A queued prompt is sent 40 ms after the Stop before it (measured), and a subagent's permission request was followed 90 ms later by the main agent's Stop (seen in a run). Two things put an event in its place:

- **The turn it belongs to.** Claude Code gives every event a `prompt_id`, the same for a prompt and for everything that follows from it, including a prompt that joins a running turn (seen in runs). The hook stores the id of the newest prompt and of the four before it. A Stop, StopFailure or dialog request that carries one of the earlier ids belongs to a turn that is over, whatever its clock says.
- **The time it happened**, which is when its hook process started. That clock can be off by tens of milliseconds, so it decides only where the turn id cannot: for an event with no id or an unknown one, and within one turn.

What is dropped:

- a Stop or StopFailure of an earlier turn, or (judged by time) older than `turnAt`, does not change the status; a late Stop still stores its reply if that is the newest one;
- a dialog request of an earlier turn, or older than `turnAt` (for a subagent: older than the last Stop that found nothing running);
- PostToolBatch and PostToolUse never end a block raised after them;
- a permission reminder sent before the last block was ended;
- anything but a SessionStart for a session that is closed.

One order can be told from neither: a dialog request that lands after the batch that already answered it. A call that cannot be asked about (a headless run, for one) is refused about 15 ms after its request, and PostToolBatch follows at once (measured). So PermissionRequest and the PreToolUse for `AskUserQuestion` and `ExitPlanMode` are registered as hooks Claude waits for, about 35 ms before a dialog; they print nothing, so the dialog shows as usual. They are the only status-only hooks in Claude's path.

Not covered: the reminder of an MCP form that is answered within the same few milliseconds it is sent can land after the batch and stay until the session's next batch or Stop.

**One writer at a time.** A hook reads the session record, changes it and writes it back. Each session has a lock directory (`sessions/<id>.lock`) around that, shared with the sidebar and the CLI when they set a label or mute. Without it, writers that start together lose each other's changes (measured before the lock: 13 and 21 of 120 changes kept). A lock that cannot be had within about half a second is skipped, and a lock older than 1.5 s is treated as left behind and removed: an event is never dropped for it, and the hooks Claude waits for are not held up longer than that. The lock has no owner mark, so in the moment a left-behind lock is taken over two writers can get in; it keeps simultaneous writers apart, it does not guarantee it. A record that exists but cannot be opened (another program has the file) is not written over: that one change is given up.

**Refused prompts.** Another tool's UserPromptSubmit hook can refuse a prompt (a policy hook, or a tool that answers its own commands that way). Claude then starts no turn and fires no Stop, and hooks for one event run side by side, so our hook cannot see the verdict. The only trace is the `system` line Claude writes to the transcript (`promptSubmitEnding.ending.kind = "blocked_by_hook"`, text `UserPromptSubmit operation blocked by hook: …`). `store.applyRefusal` reads the transcript's tail for sessions stored as `working`. The notice counts only if it is not older than the newest prompt our hook saw (`promptAt`, set at UserPromptSubmit) and no turn line (assistant output, a tool result, a real user message) follows it. `bgBefore`, also set at UserPromptSubmit, holds the background tasks that were running at that moment. Like the dead-process check this corrects the copy in memory only; the session file keeps `working` until the next prompt or Stop. An unreadable or unfamiliar transcript changes nothing.

Shown state adds one derived value: `done` is shown as **Finished · not seen yet** until the user opens the session from the sidebar or focuses its tab; after that it is shown as **Idle**. The same holds for a refused prompt: it is under **Needs you** until the user has looked, because nothing is left to answer there. A session whose tab is in front when it finishes, or when its prompt is refused, counts as looked at. "Seen" is stored in its own file (`seen/<id>`) so the sidebar never rewrites a file the hook writes.

Guards (each one is a bug cmux or herdr documented): inside a subagent only a request for the user and the end of that request reach the parent session, its other events (prompts, Stop, notifications) are ignored; an `idle_prompt` notification is not "blocked"; a late tool event cannot revive a finished session. From our own use: a prompt refused by another tool's hook must not leave the session on "working"; a tool that finishes while a dialog for another call is open must not hide the dialog.

**Names.** The name shown is the user's label, then the title, then the first prompt. The title is Claude's own (`ai-title` in the transcript, written during the first turn and repeated later) or the one the user set (`session_title` on the event, `custom-title` in the transcript). The hook stores it at SessionStart, at each prompt and at each Stop; readers fill in a missing one from the transcript.

**The sidebar's copy of the store code.** The extension carries `store.js`, and the installer puts the same file in `~/.switchboard/app`, where the hooks run it from. The sidebar uses the installed file when it is there and loads it again when it changes, so a store fix reaches an open window without a reload (a reload restarts every Claude tab in the window). A file that does not load, or lacks a function the extension calls, is not used. This runs code from `~/.switchboard/app` inside VS Code; the hooks already run code from that folder in every session, so who can change it decides both. `switchboard.useInstalledStore` turns it off.

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
| `sessions/<id>.json` | status, what is waiting, title, last prompt and reply (short), cwd, transcript path, pid | hook; sidebar and CLI for label and mute |
| `sessions/<id>.lock` | a directory that exists only while that record is being changed | whoever changes it |
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
2. Do permission dialogs in the VS Code extension fire `PermissionRequest`, `Notification`, or both? Both are handled. In a headless run (Claude Code 2.1.322) `PermissionRequest` fired for the main agent and for a subagent, about 0.1 s after `PreToolUse`; the hooks reference says the `permission_prompt` notification follows about six seconds into a dialog. Not yet watched in a VS Code window.
3. Should a link attach to a session or to something longer-lived? Session IDs survive resume, but a fresh session on the same topic starts unlinked.
4. A turn the user interrupts (Esc) sends no Stop (the hooks reference says so) and no other event. The session stays on Working, or on Needs you if a dialog was open, until its next prompt. Not handled.
5. Does a subagent that runs in the background show its permission dialog in the VS Code tab, or is the call refused without one? Either way the block ends with that subagent's PostToolBatch (within 0.2 s in the headless runs, where it was refused). Not yet watched in a VS Code window.
6. Claude Code sends no event when a permission is granted. After the user answers a dialog, the session stays under Needs you until that batch of tool calls ends, which for a long build is the whole build. Not handled; no signal to handle it with has been found.
7. A background task that never ends (a dev server started with `run_in_background`) keeps the session on Working after every Stop. By design so far ("background work means the turn is not over"); whether a long-lived shell should count is undecided.

## Handoff

- Ready for implementation: yes, and implemented in 0.1.
- Verification: 38 automated tests; an end-to-end run with two real Claude sessions (one shared through the tool, the other received the note with its next prompt); two headless runs that recorded which hook events Claude Code 2.1.322 sends for a subagent's permission request and for a queued prompt.
- Still to verify by hand in VS Code: the open questions above and the look of the two views.
