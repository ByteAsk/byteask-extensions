# ByteAsk for Zed

Drive [ByteAsk](https://byteask.ai) — the C/C++ agentic coding harness — from
[Zed](https://zed.dev).

> ### 💬 Join the community
> **[discord.gg/vx5Eu4YNzG](https://discord.gg/vx5Eu4YNzG)** — community support, direct
> access to the team, and the fastest way to report an issue. Direct email:
> **anirudha@byteask.ai**.

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/vx5Eu4YNzG)

## Why this looks different from the other connectors

Zed's extension API is sandboxed WASM with **no custom UI surface at all** —
no panels, no webviews, no way to open a terminal (verified against Zed's
own extension docs and WIT interface). That rules out a VS-Code/JetBrains-
style rich chat sidebar entirely, so this connector takes the two paths
Zed's API actually supports:

- **Slash commands** (`/byteask-exec <prompt>`, `/byteask-review`) — shell
  out to the CLI and insert the output as text, directly in Zed's own
  Assistant panel.
- **A context-server integration** — `context_server_command` returns the
  spawn command for `byteask app-server`, and Zed's *own* Agent Panel drives
  the JSON-RPC protocol and renders the streaming/approval UX. This connector
  doesn't build any of that UI itself; Zed does.

## Requires

The `byteask` CLI on `PATH`:

```bash
pip install --upgrade byteask
byteask login
byteask doctor
```

## Local development

```bash
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2
```

Then in Zed: Extensions page → **Install Dev Extension** → select this
directory. Debug via `zed: open log`, or relaunch with `zed --foreground`
for verbose logs.

## Known open items

- `Command` (from `zed_extension_api::process`) has no working-directory
  control at all — confirmed against the WIT interface. Slash commands
  resolve `byteask`'s path via the worktree's own `which()` (so at least the
  right binary runs), but rely on Zed's own process-spawn defaulting to the
  project root rather than an explicit cwd.
- `context_server_command` only receives a `Project`, which exposes
  `worktree_ids()` and nothing else (no way to get a real `Worktree` handle
  or resolve `byteask`'s path) — falls back to assuming `byteask` is on
  `PATH`, same default every other connector uses.
- Not yet manually tested inside a real Zed window (Install Dev Extension +
  clicking through `/byteask-exec` and the Agent Panel context server) —
  only compiled and verified against the actual `zed_extension_api` WIT
  interface from this environment.

## Publishing

Not yet submitted to the `zed-industries/extensions` registry. See the
[connector roadmap](../README.md) for the submission steps (fork to a
personal account, add as a git submodule, `extensions.toml` entry, PR).

## License

Apache-2.0
