# ByteAsk for JetBrains

Drive [ByteAsk](https://byteask.ai) — the C/C++ agentic coding harness — from
CLion or IntelliJ IDEA: a rich streaming chat sidebar, interactive terminal,
headless exec/review, apply diffs, and fix-diagnostics. Platform-only
(`com.intellij.modules.platform`), so the same build loads in both IDEs.

> ### 💬 Join the community
> **[discord.gg/vx5Eu4YNzG](https://discord.gg/vx5Eu4YNzG)** — community support, direct
> access to the team, and the fastest way to report an issue. Direct email:
> **anirudha@byteask.ai**.

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/vx5Eu4YNzG)

**Status: G1 (terminal/headless tier) and G2 (JCEF chat sidebar) built and
compiling clean** — `verifyPlugin` passes with zero deprecation warnings,
and the plugin loads successfully in a real headless IDE instance during
`./gradlew build`. **Not yet manually click-tested in a live `runIde`
sandbox window** (this environment can build/verify but can't drive a GUI)
— see "Known open items" below before treating either goal as fully done.

## The chat sidebar (Tools window → "ByteAsk Chat")

Reuses `vscode-byteask`'s `media/chat.html`/`chat.css`/`chat.js` **verbatim**
(zero changes) inside a JCEF-hosted browser (`JBCefBrowser`). This works
because `chat.js` only ever calls `acquireVsCodeApi().postMessage(...)` and
listens on `window.addEventListener('message', ...)` — both implemented here
via a `JBCefJSQuery` bridge instead of VS Code's native webview messaging,
so the same streaming chat, approval cards, multi-choice question tool, and
onboarding cards (CLI-not-found / not-signed-in) all come along for free.
See `ai.byteask.jetbrains.chat.*` for the Kotlin side: `ByteAskAppServerRpc`/
`ByteAskAppServerClient` (JSON-RPC-over-stdio port of
`vscode-byteask/src/appServer/`, using Gson instead of hand-porting every
generated TypeScript type), `ByteAskChatBridge` (orchestration, ported from
`chatViewProvider.ts`), and `ByteAskChatToolWindowFactory`/`ByteAskChatSession`
(the JCEF wiring itself).

## Known open items

- **Not yet manually verified in a live sandbox window.** Run
  `./gradlew runIde`, open "ByteAsk Chat", and confirm: a message actually
  streams a response, a real file-change approval renders and round-trips
  correctly, and the CLI-not-found/not-signed-in onboarding cards appear
  when expected.
- `OpenTerminalAction`'s `ShellTerminalWidget.executeCommand` cast (see its
  doc comment) is confirmed correct for the classic terminal engine against
  intellij-community source, but untested against the newer "Reworked
  Terminal" engine.
- Several `chat.js` slash-menu actions aren't wired on the Kotlin side yet:
  `mentionFile`, `uploadFile`, `switchModel`, `showStatus`, `showUsage`,
  `showDiff`, `showSkills`. `login`/`logout`/`openFile`/session
  history/resume are wired.

## Requires

The `byteask` CLI on `PATH`:

```bash
pip install --upgrade byteask
byteask login
byteask doctor
```

## Commands (Tools → ByteAsk)

| Action | CLI mapping |
|---|---|
| Open ByteAsk Terminal | `byteask` (interactive TUI) |
| Exec (Headless Prompt) | `byteask exec <prompt>` |
| Exec on Selection | `byteask exec` with the selection appended as context |
| Fix Diagnostics in Active File | `byteask exec` with formatted diagnostics from the current file |
| Review Repository | `byteask review` |
| Apply Latest Diff | `byteask apply` — no `-m`/`-c` flags, it rejects them |
| Resume Last Session | `byteask resume --last` |
| Resume Session… | `byteask resume` |

Settings: **Settings → Tools → ByteAsk** — `command`, `model`, `extraArgs`
(space-separated), `autoApply`. Same names/defaults as the VS Code and
Neovim connectors — see the [connector contract](../README.md#connector-contract).

## Development

```bash
export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home
./gradlew build           # compile + package
./gradlew runIde          # launch a sandbox IDE with the plugin loaded
./gradlew verifyPlugin    # structural/compatibility checks before a release
```

Scaffolded from [`JetBrains/intellij-platform-plugin-template`](https://github.com/JetBrains/intellij-platform-plugin-template).

## Publishing

See the repo-level [`AGENTS.md`](../AGENTS.md) for the tag-triggered release
process and required secrets (`PUBLISH_TOKEN`, signing key trio). First
upload to the JetBrains Marketplace is manual via the web UI; every version
after that — including this one — goes through manual moderation
(no fixed SLA, budget a few business days).

## License

Apache-2.0
