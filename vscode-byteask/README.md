# ByteAsk for VS Code

Drive the **[ByteAsk](https://byteask.ai)** C/C++ agentic coding harness from VS Code.

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

- `Ctrl/Cmd+Alt+B` — open the ByteAsk terminal
- `Ctrl/Cmd+Alt+E` — exec on the current selection

## Develop

```bash
npm install
npm run compile      # → out/extension.js
# Press F5 in VS Code to launch an Extension Development Host
npm run package      # build a .vsix (requires @vscode/vsce)
```

Headless commands stream via `child_process` into the **ByteAsk** output channel;
the interactive TUI runs in an integrated terminal (it needs a TTY). A future
revision will speak the structured `byteask app-server` protocol for inline diffs
and approvals.

## License

Apache-2.0
