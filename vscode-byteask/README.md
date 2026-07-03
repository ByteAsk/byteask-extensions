# ByteAsk for VS Code

Drive the **[ByteAsk](https://byteask.ai)** C/C++ agentic coding harness from VS Code.

> ### 💬 Join the community
> **[discord.gg/vx5Eu4YNzG](https://discord.gg/vx5Eu4YNzG)** — community support, direct
> access to the team, and the fastest way to report an issue or ask a question.
> Direct email: **anirudha@byteask.ai**.

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/vx5Eu4YNzG)

## Chat (primary)

The **ByteAsk** icon in the Activity Bar opens a graphical chat panel — the intended
default way to use the extension in VS Code or Cursor. Type a message, watch the
response stream in, and approve or decline proposed file changes and commands with
inline cards (no terminal, no diff-scraping). It talks to `byteask app-server`
directly (JSON-RPC over stdio), not the CLI-subcommand path below.

`Ctrl/Cmd+Alt+B` opens/focuses the chat (Command Palette: **ByteAsk: Open Chat**).

Current v1 scope: one thread per workspace session, streaming text + collapsed
"Thinking" blocks, and Accept/Decline approval cards (file changes show a "View
diff" link that opens a read-only syntax-highlighted unified diff). Session
history/resume and a model switcher aren't in the chat panel yet — use the
terminal-based commands below for those in the meantime.

## Terminal-based commands (still available)

- **ByteAsk: Open Terminal** — the interactive TUI in an integrated terminal.
- **Exec / Exec on Selection** — headless `byteask exec`; selection is sent as context.
- **Fix Diagnostics in Active File** — pipe the file's problems into `exec` for a fix.
- **Review Repository** — `byteask review`, streamed to the ByteAsk output channel.
- **Apply Latest Diff** — `byteask apply` to write the agent's diff to your tree.
- **Resume / Resume Last** — pick up a previous session.

## Requirements

```bash
pip install --upgrade byteask   # or: pipx install byteask
byteask login
byteask doctor
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `byteask.command` | `byteask` | Path to the CLI executable |
| `byteask.model` | `""` | Model passed via `-m` (empty = default) |
| `byteask.extraArgs` | `[]` | Extra CLI args (e.g. `["--oss"]`) |
| `byteask.autoApply` | `false` | Run `byteask apply` after a successful exec |

## Keybindings

- `Ctrl/Cmd+Alt+B` — open/focus the ByteAsk chat panel
- `Ctrl/Cmd+Alt+E` — exec on the current selection

(`byteask.open`, the terminal command, has no default keybinding anymore — it's
still reachable via the Command Palette as **ByteAsk: Open Terminal**.)

## Develop

```bash
npm install
npm run compile      # → out/extension.js
# Press F5 in VS Code to launch an Extension Development Host
npm run package      # build a .vsix (requires @vscode/vsce)
```

Headless commands stream via `child_process` into the **ByteAsk** output channel;
the interactive TUI runs in an integrated terminal (it needs a TTY). The chat panel
is the newer path: `src/appServer/` is a small JSON-RPC client over
`byteask app-server`'s stdio protocol; `src/appServer/generated/` is vendored,
type-only TypeScript produced by `byteask app-server generate-ts --experimental`
(regenerate it if the protocol changes — do not hand-edit those files). Both paths
coexist; nothing about the terminal/exec path changed.

## License

Apache-2.0
