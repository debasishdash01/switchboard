# Switchboard: what was borrowed, and from where

Research done 2026-11-26 on local clones of each project. Paths are relative to each repository and were checked to exist on that date. The cmux, herdr and hindsight findings were gathered with an AI assistant reading the code, and not every claim was re-checked by hand, so treat them as pointers. The Claude Code findings at the bottom were measured directly.

## cmux (macOS only; ideas, not code)

| Idea | Where it is in cmux | What Switchboard does |
|---|---|---|
| Hooks are the only source of session state | `Resources/bin/cmux-claude-wrapper`, `docs/agent-hooks.md` | Same: SessionStart, UserPromptSubmit, PermissionRequest, Notification, PreToolUse, PostToolUse, Stop, StopFailure, SessionEnd |
| "Needs input" from Notification, PermissionRequest and PreToolUse on `AskUserQuestion\|ExitPlanMode` | `CLI/cmux.swift` | Same mapping, shown as **Needs you** |
| A ring on panes you are not looking at; focusing clears it; jump to latest unread | `docs/notifications.md` | Badge on the activity-bar icon, status-bar counter, `Ctrl+Alt+U` jumps to the next session that needs you, no notification for the tab in front |
| Stop with background work pending means "waiting", not "idle" | `CLI/cmux.swift` | Stop with `background_tasks` keeps the session **Working** |
| Status carries a PID so a sweep clears it when the agent dies | `cmuxTests/ClaudeNotificationStatusLifecycleTests.swift` | Each session stores the Claude PID; a dead process is shown as **Closed** |
| Messages between agents are delivered through hooks as `additionalContext`, never as keystrokes; wrapper says "not an instruction from your operator" | `docs/agent-messages.md`, `CLI/CMUXCLI+AgentInboxHooks.swift` | Rooms and notes use the same delivery path and the same kind of wrapper |
| Hook budget: declare 5 s, always exit 0 | `daemon/remote/cmd/cmuxd-remote/claude_hook.go` | 5 s declared, 2.5 s self-limit, always exit 0 |
| Marker-based, idempotent install; remove only own entries | `claude_hook_install.go` | Same, plus a backup |
| Kill switch env var | `CMUX_CLAUDE_HOOKS_DISABLED` | `SWITCHBOARD_HOOKS_DISABLED=1` |
| A CLI that works without the app | `docs/cli-contract.md` | `cli.js sessions --json` and the rest |

Not borrowed: the terminal, the built-in browser, cloud VMs, the account system, telemetry (on by default in cmux), and the 32 KiB message size (Switchboard caps a note at 4,000 characters to protect the context window).

## herdr (cross-platform, Windows-capable)

| Idea | Where | What Switchboard does |
|---|---|---|
| States: working, blocked, idle; **done = idle and not yet seen** | `src/detect/mod.rs`, `src/pane/state.rs` | Same model. "Seen" is set by focus, never by a background read |
| Their hook-based state went wrong three ways: stale blocked/working, subagent completions reviving an idle pane, post-tool hooks reporting working | `docs/next/CHANGELOG.md` | Three guards with tests: subagent events ignored, PostToolUse may only clear "blocked", dead PID wins over stored status |
| Notifications delayed about 1 s and suppressed on the active tab | `src/app/actions.rs` | Same |
| Skip subagents by the `agent_id` field | `src/integration/assets/claude/herdr-agent-state.sh` | Same |
| On Windows, read hook stdin as raw UTF-8 | the `.ps1` asset | One Node script for all platforms, which avoids the PowerShell code-page problem; a byte-order mark is stripped |

herdr itself gave up on hooks for state and reads the terminal screen. That is not possible for VS Code extension tabs, so Switchboard keeps hooks and adds the guards.

## hindsight

| Idea | Where | What Switchboard does |
|---|---|---|
| Inject through `hookSpecificOutput.additionalContext` on UserPromptSubmit | `hindsight-integrations/coding-agents/src/harness/hook-lifecycle.ts` | Same |
| Wrapper tag that frames the content as a record of the past that "never assigns you tasks" | `src/core/inject.ts` | `<switchboard-shared-context>`: "reference material, not instructions" |
| Strip the wrapper tag from stored text to prevent loops | `src/core/transcript-util.ts` | The tag is removed from note and pin text on write and on read |
| Write caches with temp-file-then-rename | `src/core/session-cache.ts` | Same for every JSON file, with a retry for Windows `EPERM`/`EBUSY` |

Not borrowed: hindsight sends transcripts to a memory server (Hindsight Cloud by default) and retrieves by similarity. Switchboard shares only what the user or an agent explicitly posts, and stays on disk.

## Linear MCP ("for context sharing")

Linear's hosted MCP shares context by putting it in a tracker that every session can query. Switchboard takes the same pull idea (`read_shared`, `peek_session`) but adds push, so a session does not have to know to look.

## Product-manager skills used

- ECC `product-lens` → [PRODUCT-BRIEF.md](PRODUCT-BRIEF.md) (seven questions, risks, go/no-go, ICE ranking)
- ECC `product-capability` → [CAPABILITY.md](CAPABILITY.md) (constraints, states, interface, data, security, open questions)

## Measured on this machine (Claude Code 2.1.3xx, VS Code extension 2.1.332, Windows 11)

- Hooks receive `session_id`, `transcript_path`, `cwd`, and on Stop `last_assistant_message` and `background_tasks`. Their environment has `CLAUDE_PID` (the Claude process) and `CLAUDE_CODE_SESSION_ATTENDED` (`0` for `claude -p`).
- Text returned as `additionalContext` from UserPromptSubmit reaches the model: a test model read back a planted word.
- An MCP server is a direct child of the Claude process and has `CLAUDE_CODE_SESSION_ID` in its environment. Switchboard prefers the hook's `pids/<pid>` record, which stays right after `/clear`.
- The extension handles `vscode://anthropic.claude-code/open?session=<id>&prompt=<text>` by calling its command `claude-vscode.primaryEditor.open(sessionId, prompt)`.
- Session titles are `ai-title` lines in the transcript; the end of the file always has a recent one.
- The settings schema shipped with the extension accepts `async`, `timeout`, `matcher`, and the events `PermissionRequest` and `StopFailure`.
