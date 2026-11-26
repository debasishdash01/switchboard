# Switchboard: product brief

Written 2026-11-26 with the ECC `product-lens` skill (Mode 1, product diagnostic, and Mode 4, feature prioritisation). The engineering contract is in [CAPABILITY.md](CAPABILITY.md); what was borrowed from other tools is in [RESEARCH.md](RESEARCH.md).

## The seven questions

**1. Who is this for?**
One person who keeps several Claude Code sessions open as tabs in one VS Code window, each on a different workstream (taxes, a business idea, a study wiki, tooling). They work on Windows today and want the same setup on macOS or Linux.

**2. What is the pain?**
- **Attention.** With five or more tabs, there is no way to see which session is waiting for a permission click, which has finished, and which is still busy. A blocked session can sit unnoticed for an hour. Today the only fix is clicking through every tab.
- **Isolation.** Each session knows only its own conversation. When the tax session settles a figure that the business session needs, the user copies and pastes it by hand, or re-explains it, or forgets.
- **No cross-platform tool.** cmux solves the attention problem well, but it is a macOS terminal app. herdr is cross-platform but is a terminal multiplexer, so it does not help someone who uses the VS Code extension's tabs.

**3. Why now?**
Claude Code hooks now report every state change that matters (prompt sent, permission asked, turn finished) and can add text to a session's context. The VS Code extension exposes a command that opens a session by its ID. Together these make a sidebar and a context bus possible with no changes to Claude Code and no terminal emulator.

**4. What is the 10-star version?**
Sessions that work like a team: each knows what the others have decided, can ask another a question and get an answer while the user is away, and the user sees one board showing who is blocked, who is done, and what was handed to whom.

**5. What is the MVP?** (built, version 0.1)
- A **Sessions** sidebar grouped into Needs you, Finished and not seen, Working, Idle, Closed. A badge, a status-bar counter, notifications, and a "jump to the next one that needs you" shortcut.
- **Rooms**: link chosen sessions; a note shared to a room reaches the other members with their next prompt. An **Everyone** room for all sessions. A **pinned brief** per room for standing context.
- Agent tools (`share`, `read_shared`, `peek_session`, `link_sessions`) so the user can say "share this with the business session".
- A command-line tool, and an installer that works on Windows, macOS and Linux.

**6. What is the anti-goal?**
- Not a terminal or a multiplexer. No panes, no PTYs, no built-in browser.
- Not agent-to-agent automation. A note never makes another session act by itself; it waits for the user's next prompt there.
- No cloud, no account, no telemetry. Everything is files on this machine.
- No patching of the Claude Code extension.

**7. How do we know it works?**
- A blocked session is noticed within seconds: the user reaches it with one shortcut, not by scanning tabs.
- Moving a fact between two sessions takes one sentence ("share that with the tax session"), and the receiving session uses it without being told again.
- Zero cost when idle: a prompt with nothing new shared adds no tokens. (Verified by test: the hook prints nothing.)
- The hook never slows or breaks a session. (Verified by test: bad input and a disabled hook both exit cleanly with no output.)

## Risks

| Risk | Severity | What limits it |
|---|---|---|
| A note carries a prompt injection from one session into another | High | Notes arrive wrapped as "reference material, not instructions". The wrapper tag cannot be forged from inside a note. Notes need a user prompt to be delivered. |
| Sensitive context (tax, health) leaks into unrelated sessions | High | Rooms are opt-in and are the boundary: an agent can read another session only if they share a room. Sharing to Everyone is a separate, explicit target. |
| Hooks slow down or break every session | High | One small Node script. Status-only events run in the background. Hard 2.5 s self-timeout. Every error path exits 0 silently. Kill switch `SWITCHBOARD_HOOKS_DISABLED=1`. |
| Token cost of injected context | Medium | Nothing is injected when nothing is new. 4,000 characters per note, 8,000 per prompt, the rest held for the next prompt. |
| Claude Code changes its internal command for opening a session | Medium | One call site with a fallback to the documented `vscode://anthropic.claude-code/open` link. |
| "Seen" detection matches a tab by its title | Low | If two open sessions share a title, neither is auto-marked; clicking in the sidebar still marks it. |

## Recommendation

**Go**, as a personal tool. The two pains are real and daily for this user, the building blocks are public, and the whole product is about 2,200 lines with no dependencies. Not a candidate for a paid product yet: Anthropic or cmux could ship the same thing, and the VS Code session list is moving fast.

## Feature prioritisation (ICE: impact × confidence ÷ effort, each 1–5)

| # | Feature | I | C | E | Score | Status |
|---|---|---|---|---|---|---|
| 1 | Sessions sidebar with live status | 5 | 5 | 2 | 12.5 | Built |
| 2 | Needs-you badge, status bar, jump shortcut | 5 | 5 | 1 | 25 | Built |
| 3 | Rooms + notes delivered on next prompt | 5 | 4 | 2 | 10 | Built |
| 4 | Everyone room (share with all) | 4 | 5 | 1 | 20 | Built |
| 5 | Agent tools to share / read / peek | 5 | 4 | 2 | 10 | Built |
| 6 | Pinned brief per room | 3 | 4 | 1 | 12 | Built |
| 7 | Share editor selection / last reply from the sidebar | 3 | 4 | 1 | 12 | Built |
| 8 | Wake an idle session when a note arrives (`asyncRewake`) | 4 | 2 | 3 | 2.7 | Later |
| 9 | Ask another session a question and get its answer back | 4 | 2 | 4 | 2 | Later |
| 10 | Per-session git branch, ports, cost in the row | 2 | 4 | 2 | 4 | Later |
| 11 | Sound or OS-level notification when VS Code is not focused | 3 | 3 | 2 | 4.5 | Later |
| 12 | Auto-summary of a session into its room when it finishes | 3 | 2 | 3 | 2 | Later, opt-in only (cost and privacy) |
| 13 | Rooms that follow a project folder, not single sessions | 3 | 3 | 2 | 4.5 | Next, once real use shows whether sessions are too short-lived |

Next step after a week of use: check whether links should attach to something longer-lived than one session (item 13).
