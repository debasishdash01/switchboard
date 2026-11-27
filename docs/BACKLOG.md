# Switchboard: backlog

Written 2026-11-27 after looking at what already exists. Each item says where the idea comes from, what it would change, and how much work it is. The fixed rules in [CAPABILITY.md](CAPABILITY.md#constraints-fixed-rules) still apply: local only, no dependencies, public Claude Code surface only, the hook never hurts a session.

Effort: **S** about an hour or two, **M** about half a day, **L** a day or more. **Spike** means find out first, then decide.

## What changed around us

Two things Claude Code now ships overlap with Switchboard:

- **Messaging between sessions** ([docs](https://code.claude.com/docs/en/cross-session-messaging.md), v2.1.234+ on native Windows). `ListAgents` / `SendMessage`, `/list-agents`. A message to an idle session **starts a turn** (it wakes the session). Sessions on the same machine talk over a local socket or named pipe. `SendMessage` has `notify_when_idle`, a single notice when the other session next finishes. There are no persistent notes, rooms or pinned briefs, and no busy, idle or working state per row.
- **Agent View** ([docs](https://code.claude.com/docs/en/agent-view.md), `claude agents`, research preview). A board in the terminal. `claude agents --json --all` prints every live session, **interactive ones included**, with `status` (`busy` / `waiting` / `idle`), `waitingFor` (`permission prompt`, `input needed`, …), `pid`, `sessionId` and `name`. The docs don't mention the VS Code extension.

So Switchboard is still the only board inside VS Code for the extension's tabs, and the only one with shared context that persists. Its message delivery is now weaker than the built-in one, because the built-in one wakes idle sessions. The backlog below leans on the built-ins where they are stronger, rather than competing with them.

Other tools looked at: [SessionDeck](https://github.com/len5ky/sessiondeck) (VS Code, transcripts plus optional hooks, paid), [Monet](https://github.com/ivanpush/Monet) (VS Code terminals, hooks), [Claude Code Agent Manager](https://github.com/KyleJamesWalker/vscode-cc-agent-manager) (VS Code, reads transcripts only), [claude-second-screen](https://github.com/steima/claude-second-screen) (browser board, hooks), [claude-context-sync](https://mcp.so/servers/claude-context-sync) (MCP, conflict detection). All were read from their READMEs or docs on 2026-11-27, not from their code.

## Spikes: do these first

| # | Question | Why it matters | Effort |
|---|---|---|---|
| S1 | Does `claude agents --json --all` list the **VS Code extension's** sessions, with `status` and `waitingFor`? How long does one call take on this laptop? | If yes, it is a supported source of state that fixes open questions 4 and 6 (see B1). If no, drop B1. | S |
| S2 | When a built-in `SendMessage` message wakes an idle session, which hooks fire? Is there a `UserPromptSubmit`, and what does its prompt text look like? | Switchboard may store the message as "last prompt", or mishandle the turn the same way a `<task-notification>` turn was mishandled. It needs a guard like `SELF_STARTED` in `core/hook.js`. | S |
| S3 | A VS Code session cannot show the approve dialog for a **held** message (the docs say so). Does a held message leave any trace Switchboard can see (transcript line, notice)? | If it does, Switchboard can show "1 message waiting for approval" under Needs you, which no tool covers today. | S |
| S4 | Can the hook use `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN` (exported to hooks) to post a note into its own session, on Windows named pipes? | Needed only for B2 (wake on note). | M |

### Spike results (2026-11-27, Claude Code 2.1.322)

- **S1: yes.** `claude agents --json --all` lists the VS Code extension's tabs (matched by `pid` and `sessionId` against Switchboard's records with `entrypoint: claude-vscode`), as `kind: "interactive"`. One call takes about 0.8 s with 14 live sessions. The fields seen were `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name` and `status`. `waitingFor` did not appear because nothing was waiting at the time, so it is still unverified. Two things to know for B1: Agent View shows a session whose turn ended but whose background shell still runs as `idle` (Switchboard shows it as working with 1 in the background, which is more useful), and its `name` is the session title once there is one (`debasish-work-ef` before that), which helps B6.
- **S2: a real bug, fixed.** A delivered message fires `UserPromptSubmit` with a prompt that starts `<agent-message from="…">`. Subagent hand-backs arrive the same way (37 of the 45 such prompts in the local transcripts). Switchboard stored them as the user's last prompt, and they ended subagent blocks as if the user were typing. `SELF_STARTED` in `core/hook.js` now covers `<agent-message`, and `recentTurns` (peek) skips those lines. A message sent from another session was not triggered live, so its `from` value was not seen, but the prefix is the same.

### Item status (2026-11-27)

- **A1 done**: `store.applyInterrupt` reads the interrupt marker (both `[Request interrupted by user]` and `… for tool use]`) and shows the session as Idle. Background work keeps it Working.
- **A2 already there**: each row already ends with how long the session has been in its state, and shows `N background`. Nothing to build.
- **A4 mostly there, finished**: the notice already said "needs you: Needs your permission: Bash" with an Open button. A question now shows its text: `Asking you: <first question> (1 of 2 questions)`.
- **A7 done**: right-click a session → "Tell Me When It Finishes / Stop Watching". One notice when it finishes, is interrupted or closes, even with `switchboard.notify` off, and then the watch ends. A dialog on the way does not end it. Rows show `watching`.
- **B1 done**: the sidebar asks `claude agents --json --all` when a status looks stale and corrects it in memory. One change from the plan: "no event for 2 minutes" became "no hook write and no transcript write for 2 minutes", because the hook writes a record only when the state changes, so a turn longer than 2 minutes would always have looked stale. See CAPABILITY.md, "The second opinion from `claude agents`". Not yet seen in a real window.
- **A8 done**: `doctor` counts titles, interrupt markers and refused-prompt notices in the 20 newest transcripts, and warns when no titles are found.
- **B2 not built (your choice, 2026-11-27).** Fixed rule 6 stays: nothing wakes a session. Built instead, as **A10**: each open row shows `✉ N notes waiting` when shared notes are queued for that session's next prompt, with the rooms in the tooltip. The count comes from `store.unreadFor`, the same function delivery uses, so a muted Everyone room, the first-read limit and a session's own notes are counted the way they will be delivered. Closed sessions show no count. Not yet seen in a real window.

## Build next: small, clear wins

| # | Item | From | What it changes | Effort |
|---|---|---|---|---|
| A1 | **Treat an interrupted turn (Esc) as idle** by reading the transcript's interrupt marker on the reader side, the same way `applyRefusal` reads a refused prompt | SessionDeck (turn boundary from the transcript: `end_turn` = done, interrupt marker = idle) | Closes open question 4 and the limit "a turn you interrupt stays on Working" | M |
| A2 | **How long it has been waiting** in each row: `blocked 4m`, `working 12m · 2 bg tasks` | Agent View (`waiting 3m`), SessionDeck captions | Shows at a glance which blocked session is oldest, and makes the "permission granted but still under Needs you" case (open question 6) easy to read | S |
| A3 | **"Quiet" hint**: append `· quiet 15m` when a block or a tool has lasted far longer than usual. Never change the status on a guess | SessionDeck | A cheap signal for open questions 6 and 7 without inventing state | S |
| A4 | **Say what is wanted** in the notification and the row: "needs permission for Bash", or the question text, with an Open button. Check what the notification says today first | SessionDeck | Fewer clicks to decide whether to go now | S |
| A5 | **Collapse a burst**: 3 or more new blocks within 45 s become one notification with a "Show" button | SessionDeck (Triage) | No notification storm when a fan-out of subagents all ask at once | S |
| A6 | **Previous / next that needs you, oldest first** (`Ctrl+Alt+U` exists; add the reverse, define the order) | SessionDeck | | S |
| A7 | **Watch this session**: right-click → "Tell me when it finishes", which notifies even when `switchboard.notify` is `blocked` | built-in `notify_when_idle` | The same idea using state Switchboard already has. No tokens | S |
| A8 | **Format check in `doctor`**: warn when the transcript lines Switchboard relies on (`ai-title`, the refused-prompt notice, the interrupt marker after A1) were not found in recent transcripts | SessionDeck (format-drift detection) | CAPABILITY.md admits those formats are not a documented interface. This turns a silent break into a visible one | S |
| A9 | **Sound / OS notification when VS Code is not focused**, limited to once per 30 s | SessionDeck; old ICE item 11 | | S |
| A10 | **"N notes waiting" on each row**: show how many shared notes wait for a session's next prompt | the B2 discussion | Shows that a note is waiting without breaking rule 6. `store.unreadFor` already existed; only the `whoami` tool used it | S |

## Then: bigger, worth it if real use asks for it

| # | Item | From | What it changes | Effort |
|---|---|---|---|---|
| B1 | **Use `claude agents --json` as a second source of truth.** Call it only when something looks stale (blocked for more than 30 s, working with no event for more than 2 min), never on a timer for every session. Trust it for `busy` vs `waiting` | Agent View | Fixes "permission granted, still under Needs you" (open question 6) and interrupted turns. Depends on S1. Stays on the public surface (a documented CLI command) | M |
| B2 | **Wake on note (opt-in per room).** When a note is shared to a room, also post it to idle members through the built-in messaging (S4), so it does not wait for the next prompt | built-in messaging | Closes Switchboard's biggest gap against the built-in. **Your decision:** it breaks fixed rule 6 ("delivery needs the user") and the anti-goal "a note never makes another session act by itself". Woken turns cost tokens. Default off. **Not built (2026-11-27): A10 instead** | M–L |
| B3 | **Touched-the-same-file warning.** Record which files each live session wrote (an async `PostToolUse` on `Edit\|Write\|NotebookEdit`) and flag in the sidebar when two live sessions touched the same file within an hour | claude-context-sync (it goes down to the symbol level; file level is enough here) | Catches two tabs editing the same repo. Local and cheap, but it re-adds a `PostToolUse` hook (async, so it is not in Claude's path) | M |
| B4 | **Move a terminal session into the editor**: stop the outside process, wait until it has exited (offer force after 5 s, never resume while it lives), then open it in a Claude tab | SessionDeck "Move into Editor" | Closes the limit "a session in a terminal cannot be brought to the front" | M |
| B5 | **Rooms that follow a project folder** (old ICE item 13) | own backlog | Still waiting on a week of real use, as planned | M |
| B6 | **Use Claude Code's own session name** (`/rename`, `--name`, the default `my-app-3f`) as a fallback before the title, so "share with X" in Switchboard and `SendMessage` to X mean the same session | Agent View / messaging naming | One name across both tools | S |

## Nice to have

| # | Item | From | Effort |
|---|---|---|---|
| C1 | Colour per project folder in the rows | Monet | S |
| C2 | Group by state ⇄ group by folder toggle; a filter box (`s:blocked`, part of a name) | Agent View, SessionDeck | S–M |
| C3 | Pin a session to the top of its group | Agent View, Agent Manager | S |
| C4 | Export a room's notes, or a session's last turns, to Markdown with Obsidian-style links (useful for the wikis) | Agent Manager | M |
| C5 | Git branch and open PR per row (old ICE item 10) | Agent View PR labels | M |
| C6 | Row caption from the first line of the stored last reply (already stored, so no model call) | Agent View summaries, without the model | S |

## Not doing, and why

- **Model-written row summaries** (Agent View, Monet titles, claude-context-sync): a model call per turn, against "no cost when idle". The non-goal "summarising sessions with a model" stays.
- **Reading the terminal screen, `?`-ending heuristics** (Agent Manager reports 92% precision): hooks plus transcript checks are already better.
- **Sessions on other machines, WSL, SSH, cloud** (SessionDeck bridge, built-in Remote Control): a non-goal. The built-in messaging covers this if it is ever needed.
- **A floating always-on-top window, a browser board**: VS Code cannot float a webview, and a board in the browser duplicates the sidebar.
- **Competing with `SendMessage` for one-off messages**: use the built-in. Switchboard keeps what it lacks: rooms, the Everyone room, pinned briefs, and `peek_session` limited by room.

## Suggested order

1. S1 and S2 (an hour together). S2 can expose a real bug today.
2. A1, A2, A4, A7, A8: the small fixes to state and attention.
3. Then B1 if S1 says yes, and decide B2.
