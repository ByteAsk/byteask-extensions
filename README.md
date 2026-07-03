# ByteAsk Editor Extensions

Editor and IDE connectors for **[ByteAsk](https://byteask.ai)** — the Codex-style
agentic coding harness specialized for **C/C++** (compiler, disassembler, and
debugger as first-class agent tools).

Each connector drives the same `byteask` CLI, so behavior stays consistent across
editors and every connector inherits new engine capabilities for free.

> ### 💬 Join the community
> **[discord.gg/vx5Eu4YNzG](https://discord.gg/vx5Eu4YNzG)** — community support, direct
> access to the team, and the fastest way to report an issue. You can also reach us
> directly at **anirudha@byteask.ai**.

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/vx5Eu4YNzG)

## Connectors

| Editor | Package | Status |
|---|---|---|
| Neovim | [`ByteAsk/ByteAsk.nvim`](https://github.com/ByteAsk/ByteAsk.nvim) (separate repo) | ✅ ready |
| VS Code | [`vscode-byteask`](./vscode-byteask) | ✅ ready |
| Zed | [`zed`](./zed) | 🚧 built (slash commands + context server), not yet submitted to the registry |
| Emacs | `byteask.el` | 🛠 planned |
| JetBrains (CLion/IDEA) | [`jetbrains`](./jetbrains) | 🚧 built, pending manual `runIde` verification |
| Helix / Sublime | — | 🛠 planned |

## The integration surface

Every connector targets one or more of these `byteask` entry points. New connectors
should prefer the highest tier they can support.

**Tier 1 — Terminal (works everywhere).**
Spawn the interactive TUI in the editor's terminal:
`byteask [PROMPT] -m <model> -c <key=value>`. This is what `codex.nvim` does; it's
the fastest path to a working connector.

**Tier 2 — Headless commands (structured actions).**
Shell out and stream results, no TTY required:
- `byteask exec [PROMPT]` — one-shot task. `--json` emits JSONL events;
  `-o <file>` writes the final message; `--output-schema <file>` constrains output.
- `byteask review` — repository code review.
- `byteask apply` — apply the agent's latest diff to the working tree (git apply).
- `byteask resume [--last]` / `byteask fork [--last]` — session control.

**Tier 3 — App-server protocol (native UX).**
`byteask app-server` runs a daemon with a ws/unix control socket the TUI itself
uses via `--remote`. `byteask app-server generate-ts --out <dir>` and
`generate-json-schema` emit typed bindings, so a connector can render inline diffs,
approvals, and streaming tool calls natively instead of scraping a terminal.
This is the target end-state for the flagship connectors.

## Connector contract

To keep the ecosystem consistent, every connector should expose (named per the
editor's conventions):

| Capability | CLI mapping |
|---|---|
| Open / toggle interactive session | `byteask` (Tier 1 terminal) |
| Exec a prompt (headless) | `byteask exec <prompt>` |
| Exec on selection (send as context) | `byteask exec` with selection appended |
| Fix diagnostics in current file | `byteask exec` with formatted diagnostics |
| Review repository | `byteask review` |
| Apply latest diff | `byteask apply` |
| Resume / fork session | `byteask resume` / `byteask fork` |
| Health check | `byteask doctor` |
| Setting: command path, model, extra args, auto-apply | `-m`, `-c`, argv |

Reference implementations: `byteask.nvim/lua/byteask/` (Lua) and
`vscode-byteask/src/extension.ts` (TypeScript) both follow this contract.

## Install the CLI

All connectors require the `byteask` CLI:

```bash
pip install --upgrade byteask   # or: pipx install byteask
byteask login
byteask doctor
```

## Contributing a new connector

1. Copy the connector contract above.
2. Start at Tier 1 (terminal) for a working v0, then add Tier 2 headless commands.
3. Use `byteask doctor` for the editor's health check.
4. Match the setting names (`command`, `model`, `extraArgs`, `autoApply`).

## For coding agents

See **[`AGENTS.md`](./AGENTS.md)** — the CLI-exact install commands, the
release process (tag → verify), required secrets and where to get them, and a
CI gotcha worth reading before touching any workflow file.

## License

Apache-2.0
