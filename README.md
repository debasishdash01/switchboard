# Switchboard

See every Claude Code session at a glance, jump to the one that needs you, and share context between sessions. For people who run many Claude sessions as tabs in VS Code. Works on Windows, macOS and Linux. Everything stays on your machine.

It brings the parts of [cmux](https://github.com/manaflow-ai/cmux) that matter for VS Code tabs (a session list with live status, "needs you" alerts, jump to unread) and adds shared context between sessions.

> **Status: 0.1, early.** The automated tests pass and it has been tried with real Claude Code sessions, but it has had little day-to-day use. It installs hooks into your Claude Code settings, so read [Install](#install) first.
>
> Unofficial. Not affiliated with or endorsed by Anthropic or cmux. MIT licensed, with no warranty.

## What you get

**Sessions view** (Switchboard icon in the activity bar)

| Group | Meaning |
|---|---|
| Needs you | Waiting for a permission click, an answer to a question, or stopped on an error |
| Finished · not seen yet | The turn ended and you have not looked at it |
| Working | Busy (including background tasks that are still running; a monitor that only watches does not count) |
| Idle | Finished and seen |
| Closed | The session's process has ended. Click to reopen it |

- Click a session to open it. `Ctrl+Alt+U` (`Cmd+Alt+U`) jumps to the next one that needs you. `Ctrl+Alt+J` switches by name.
- The icon shows a count; the status bar shows `2 need you · 1 finished · 3 working`.
- A notification appears when a session you are not looking at starts needing you or finishes (`switchboard.notify`: `all`, `blocked`, `off`).

**Rooms view** (shared context)

- **Link sessions**: pick two or more sessions, name the room (for example "Tax + Entrepreneurship"). From then on, a note shared in the room reaches the other members with their next prompt.
- **Everyone**: a built-in room. A note there reaches every session. Mute it per session from the right-click menu.
- **Pinned brief**: standing context for a room, kept in a plain file. Members get it when they start and whenever you change it.
- Ways to share:
  - Tell a session: "share that with the tax session" or "share this with all sessions". The agent writes the note and calls the `share` tool.
  - Right-click a session → **Share Its Last Reply…** or **Ask It to Write a Handoff Note…**
  - The comment icon on a room, or **Share a Note with All Sessions…**
  - Select text in any file → right-click → **Switchboard: Share Selection with Sessions…**
- An agent can also pull: `peek_session` reads the last turns of a session it is linked with. Sessions that do not share a room cannot read each other.

## Install

Needs Node 18+, Claude Code, and VS Code with the Claude Code extension.

```
node install.js
```

Then reload the VS Code window. Sessions that were already open show up after you restart their tab, because Claude Code loads hooks and tools when a session starts.

The installer changes exactly these things:

| Where | What |
|---|---|
| `~/.switchboard/app/` | a copy of `core/` |
| `~/.claude/settings.json` | hook entries that point at `~/.switchboard/app/hook.js` (backup written to `settings.json.switchboard-backup`) |
| Claude Code user MCP config | a server named `switchboard` |
| `~/.claude/skills/switchboard/` | the skill |
| VS Code | the `local.switchboard` extension, built into `dist/switchboard.vsix` |

Remove it with `node install.js --uninstall` (add `--purge` to delete rooms and notes too). Turn the hooks off without uninstalling by setting `SWITCHBOARD_HOOKS_DISABLED=1`.

The first time an agent calls `share`, `link_sessions` or `peek_session`, Claude asks for permission. Choose "always allow" if you want it silent.

## Command line

```
node ~/.switchboard/app/cli.js sessions            # list sessions and their state
node ~/.switchboard/app/cli.js link tax entre --name "Tax + Entrepreneurship"
node ~/.switchboard/app/cli.js share all "Laptop restarts at 6pm"
node ~/.switchboard/app/cli.js notes "Tax + Entrepreneurship"
node ~/.switchboard/app/cli.js doctor              # check the installation
```

Sessions and rooms can be named by part of their name or the start of their ID.

## How it works

```
Claude session ──hook──▶ ~/.switchboard/ (plain files) ◀── VS Code sidebar
      ▲                        ▲     │
      │                        │     └── notes waiting for a session are printed by its
      └── MCP tools (share,    │         hook at the next prompt, inside
          read_shared, peek) ──┘         <switchboard-shared-context>
```

- No server or background process. The hook, the agent tools, the command line and the sidebar all read and write the same files.
- A prompt with nothing new shared adds nothing to the session's context.
- Limits: 4,000 characters per note, 8,000 per prompt. Extra notes wait for the next prompt.

## Privacy and safety

- No network calls and no telemetry.
- A note is copied into every member session's conversation, and so to Anthropic as part of that conversation, like anything else you type there. Share tax or health details to a named room, not to Everyone.
- Received notes are marked as reference material, not instructions, and Claude still asks before running tools. That reduces, but does not remove, the risk of one session passing a bad instruction to another. Do not link a session that reads untrusted web content with one that has broad permissions.
- Files under `~/.switchboard` are readable by anything running as you, the same as Claude's own transcripts.

## Limits in 0.1

- A note is delivered with the receiving session's **next prompt**. It does not wake an idle session.
- A session running in a terminal is listed, but clicking it cannot bring that terminal to the front.
- "Seen" is detected by matching the focused tab's title to the session title. Two open sessions with the same title are marked seen only when opened from the sidebar.
- Links attach to sessions. A brand-new session on the same topic starts unlinked.

## Development

```
node --test test/switchboard.test.js test/extension.test.js   # 17 tests
node test/e2e-config.js /tmp/sb    # config to try real sessions without installing
```

- `core/store.js`: the file store. `core/hook.js`: the Claude Code hook. `core/mcp.js`: agent tools. `core/cli.js`: command line.
- `vscode/`: the extension (plain JavaScript, no build step). `skill/`: the skill.
- `docs/`: [product brief](docs/PRODUCT-BRIEF.md), [capability contract](docs/CAPABILITY.md), [research](docs/RESEARCH.md).

## License

[MIT](LICENSE)
