# AGENTS.md — byteask-extensions

This file is for coding agents (Claude Code, Codex, etc.) working in this repo
or in a project that depends on its published extensions. Humans should read
`README.md` instead; this file assumes you already know how to run shell
commands and just need the exact facts.

## What this repo is

Monorepo for ByteAsk editor connectors that don't need to live at their own
repo root — currently `vscode-byteask/` (VS Code / Cursor / Windsurf /
VSCodium), `jetbrains/` (CLion / IntelliJ IDEA), `zed/` (Zed), and `emacs/`
(Emacs). The Neovim connector lives in the separate
repo `ByteAsk/ByteAsk.nvim` because Neovim plugin managers require plugin
code at repo root — see that repo's own `AGENTS.md` for why. All drive the
same `byteask` CLI.

Each connector is released independently (its own tag prefix, its own
version file) — see `scripts/release.sh` / `scripts/connectors.conf` and
"If you're cutting a release" below before hand-typing a `git tag`.

## If you're installing/using the VS Code extension in a project

It's published on three channels; pick based on which editor:

```bash
# VS Code proper — Marketplace
code --install-extension byteask.byteask-vscode

# Cursor / Windsurf / VSCodium — Open VSX (these can't use the MS Marketplace)
cursor --install-extension byteask.byteask-vscode

# Manual / air-gapped — download the .vsix from the latest GitHub Release
gh release download vscode-vX.Y.Z --repo ByteAsk/byteask-extensions -p '*.vsix'
code --install-extension byteask-vscode.vsix
```

Requires the `byteask` CLI on `$PATH` (same as the nvim connector):

```bash
pip install --upgrade byteask
byteask login
byteask doctor
```

Commands (Command Palette): `ByteAsk: Open Terminal`, `ByteAsk: Exec`,
`ByteAsk: Exec on Selection`, `ByteAsk: Fix Diagnostics in Active File`,
`ByteAsk: Review Repository`, `ByteAsk: Apply Latest Diff`, `ByteAsk: Resume
Last Session`. Settings under `byteask.*` (`command`, `model`, `extraArgs`,
`autoApply`) — see `vscode-byteask/README.md`.

## The connector contract (read before adding a new editor connector)

Every connector maps to the same fixed CLI surface — keep new connectors
(Zed, Emacs, JetBrains, ...) consistent with this table:

| Capability | CLI mapping |
|---|---|
| Open / toggle interactive session | `byteask` (terminal, needs a TTY) |
| Exec a prompt (headless) | `byteask exec <prompt>` |
| Exec on selection | `byteask exec` with selection appended as context |
| Fix diagnostics in current file | `byteask exec` with formatted diagnostics |
| Review repository | `byteask review` |
| Apply latest diff | `byteask apply` — **no `-m`/`-c` flags**, it rejects them |
| Resume / fork session | `byteask resume [--last]` / `byteask fork [--last]` |
| Health check | `byteask doctor` |
| Settings | `command`, `model`, `extraArgs`, `autoApply` |

Reference implementations: `byteask.nvim/lua/byteask/` (Lua) and
`vscode-byteask/src/extension.ts` (TypeScript).

## If you're cutting a release

**This repo hosts multiple independently-versioned connectors** (vscode-byteask,
jetbrains, and more to come), each with its own tag prefix (`vscode-v*`,
`jetbrains-v*`, ...) and its own version file (package.json, gradle.properties,
...). Don't hand-type `git tag <prefix>-vX.Y.Z` — that's exactly how a real
mistake happened: `jetbrains-v0.1.0` got tagged and pushed for a version that
had already been manually uploaded to the Marketplace, and the publish
workflow correctly failed on "version already exists" (annoying but harmless
by itself) -- except a *separate*, now-fixed bug meant that failure also
silently skipped the GitHub Release step, and nobody would have caught the
duplicate-version problem locally before pushing.

**Use `scripts/release.sh` instead** — it reads each connector's actual
current version, refuses to proceed if that version is already tagged
(locally or on origin), and refuses if the working tree has uncommitted
changes or local main is behind origin:

```bash
scripts/release-status.sh          # at-a-glance: every connector's version vs. latest tag
scripts/release.sh vscode           # dry-run: shows the plan, tags nothing
scripts/release.sh vscode --yes     # actually tags + pushes
scripts/release.sh --list           # list every registered connector
```

Adding a new connector (Zed, Emacs, Sublime, ...)? Add one line to
`scripts/connectors.conf` (name, directory, tag prefix, and a shell command
that prints its current version) — that's the only place this ever needs
wiring, both scripts read it.

`byteask.nvim` is NOT in this registry — it's a separate repo with its own
plain `vX.Y.Z` tags (see its own `AGENTS.md`), so it doesn't have the
multi-connector disambiguation problem this solves.

### VS Code release destinations

`vscode-v*` triggers `.github/workflows/vscode-publish.yml`, which packages
the `.vsix` once and publishes to three destinations in sequence:

1. **VS Code Marketplace** — `vsce publish`, only if `VSCE_PAT` is set
2. **Open VSX** (Cursor/Windsurf/VSCodium) — `ovsx publish`, only if
   `OVSX_TOKEN` is set; treats "version already published" as success (so a
   re-run to backfill a later channel doesn't false-fail on this step)
3. **GitHub Release** — always runs, attaches the `.vsix`, no secret needed

Each secret-gated step **self-skips** (not fails) if its secret is absent —
so you can cut a release with only some channels configured and backfill the
rest later without re-tagging:

```bash
# after a missing secret gets added post-hoc, re-run against the same tag:
gh workflow run "Publish VS Code Extension" --repo ByteAsk/byteask-extensions --ref vscode-vX.Y.Z
```

Verify it landed:

```bash
gh run list --repo ByteAsk/byteask-extensions --limit 3
gh release view vscode-vX.Y.Z --repo ByteAsk/byteask-extensions

# confirm each channel directly (propagation can lag a few minutes)
curl -s https://open-vsx.org/api/byteask/byteask-vscode | python3 -m json.tool
curl -s -X POST "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery" \
  -H "Content-Type: application/json" -H "Accept: application/json;api-version=3.0-preview.1" \
  -d '{"filters":[{"criteria":[{"filterType":7,"value":"byteask.byteask-vscode"}]}],"flags":914}' \
  | python3 -m json.tool
```
Note: the Marketplace's public `/items?itemName=...` page can lag well behind
the Gallery API above (minutes to an hour) — trust the API response, not a
404 on the item page, when confirming a fresh publish.

### CI (runs on every push, not just tags)

`.github/workflows/vscode-ci.yml`: `npm ci`, `npm run compile` (tsc
typecheck), and a `vsce package` dry-run to catch manifest errors before they
reach a tag. Run locally before pushing:

```bash
cd vscode-byteask
npm ci
npm run compile
npx --yes @vscode/vsce package --no-dependencies -o /tmp/check.vsix
```

### Required secrets (repo-level, `gh secret set <NAME> --repo ByteAsk/byteask-extensions`)

| Secret | Required for | Where to get it | Notes |
|---|---|---|---|
| `VSCE_PAT` | VS Code Marketplace | `marketplace.visualstudio.com/manage` → publisher `byteask` (create if missing at `/manage/createpublisher`) → Azure DevOps → User Settings → Personal Access Tokens → scope **Marketplace: Manage** | Optional — publish still succeeds without it, just skips this channel |
| `OVSX_TOKEN` | Open VSX (Cursor/Windsurf/VSCodium) | `open-vsx.org` → sign in with GitHub → user settings → Access Tokens | Also needed once, interactively, to claim the namespace: `npx ovsx create-namespace byteask -p <token>` (already done as of v0.1.0 — only needed again for a brand-new namespace) |

**You (the agent) cannot obtain these interactively.** If a secret is missing
and you need it for a release, tell the user exactly which one and where to
get it (the table above), then wait — do not guess a value or skip the step
silently without saying so.

Set a secret non-interactively once the user gives you the value:

```bash
printf '%s' '<value>' | gh secret set VSCE_PAT --repo ByteAsk/byteask-extensions
```

(`printf '%s' | gh secret set` avoids the value landing in shell history via a
literal argument or an `echo` with interpolation.)

### Workflow-authoring gotcha (already hit once, don't repeat it — see also `ByteAsk/ByteAsk.nvim/AGENTS.md`)

**GitHub Actions rejects `secrets.*` referenced directly inside a step-level
`if:` condition** — not a lint warning, a hard `startup_failure` that zeroes
out `jobs: []` on every trigger. `vscode-publish.yml` already does this
correctly (checks `env.VSCE_PAT` / `env.OVSX_TOKEN`, set at job-level `env:`
from the secrets) — copy that pattern for any new gated step, and lint before
pushing:

```bash
brew install actionlint   # one-time
actionlint .github/workflows/*.yml
```

## JetBrains plugin (`jetbrains/`) — build, test, release

Requires JDK 17+ (2025.1+ platform requires 21) — this repo's dev machine
needed `brew install openjdk@21` since only 11 was present; no system-wide
Gradle install needed, the wrapper (`./gradlew`) handles that itself.

```bash
cd jetbrains
export JAVA_HOME=$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home
./gradlew build            # compile + package the plugin zip
./gradlew runIde            # launch a real sandbox IDE with it loaded -- the
                             # only way to actually confirm the terminal
                             # integration (see caveat below) and tool window
./gradlew verifyPlugin      # structural/compatibility checks before a tag
```

**Known open verification item**: `OpenTerminalAction` casts the `TerminalWidget`
returned by `TerminalToolWindowManager.createShellWidget()` to
`ShellTerminalWidget` to call `executeCommand()` — confirmed as the current,
non-deprecated entry point against intellij-community source, but IDEs with
the newer "Reworked Terminal" engine enabled may not support that cast. Run
`./gradlew runIde` and manually trigger "Open ByteAsk Terminal" to confirm
before considering G1 fully done; the fallback (shell opens without
auto-running the command) is not a crash either way.

Release: `scripts/release.sh jetbrains --yes` (see "If you're cutting a
release" above — bumps the version in `gradle.properties` first if 0.1.1
is already tagged), triggers `jetbrains-publish.yml`. Unlike the VS Code
channels, **the first-ever version must be uploaded manually** via
plugins.jetbrains.com before `publishPlugin` can push anything automated —
already done as of 0.1.0. Every version after that (including updates)
still goes through JetBrains' own manual moderation review (no fixed SLA;
budget a few business days) — this is slower than the VS Code/Neovim
channels, plan hotfix timing accordingly.

Required secrets: `PUBLISH_TOKEN` (Marketplace vendor dashboard → Permanent
Tokens), `PRIVATE_KEY` / `PRIVATE_KEY_PASSWORD` / `CERTIFICATE_CHAIN` (plugin
signing — see [plugin-signing docs](https://plugins.jetbrains.com/docs/intellij/plugin-signing.html)).
Same self-skip convention as the VS Code secrets: the Marketplace publish
step no-ops if `PUBLISH_TOKEN` is absent, so a GitHub-Release-only cut still
works without them.

## Zed extension (`zed/`) — build, test, publish

Rust, compiled to `wasm32-wasip2` (Zed's sandboxed WASM extension model --
no arbitrary FS/HTTP, no custom UI surface at all, confirmed against Zed's
own extension docs and WIT interface). Requires the wasm target once:

```bash
rustup target add wasm32-wasip2
rustup component add rustfmt clippy   # if not already present
```

```bash
cd zed
cargo fmt -- --check
cargo clippy --target wasm32-wasip2 -- -D warnings
cargo build --target wasm32-wasip2
```

**Two real API gaps discovered while building this, both documented in
`zed/src/lib.rs`'s comments** -- don't assume either is fixable by trying a
different method name; both were confirmed against the actual WIT interface
(`~/.cargo/registry/.../zed_extension_api-<version>/wit/since_v0.6.0/extension.wit`),
not docs, which lag the real API:
- `zed_extension_api::process::Command` has **no working-directory control
  at all** (just `{command, args, env}`).
- `context_server_command` only receives a `Project`, which exposes
  `worktree_ids() -> list<u64>` and **nothing else** -- no way to resolve an
  actual `Worktree` handle or its `which()`-equivalent from there.

Local dev-testing: Zed's Extensions page → **Install Dev Extension** → pick
this directory (Zed cross-compiles for you). This is a real GUI action --
if you're an agent without a display, you cannot verify this step yourself;
say so rather than claiming it works.

Publishing is **not** tag-triggered like VS Code/JetBrains -- there is no
`zed-publish.yml`. The registry (`zed-industries/extensions`) is a separate
GitHub repo you submit a PR to: fork it to a **personal** account (not an
org, so Zed staff can push fixes), add this directory's repo as a git
submodule, add an `extensions.toml` entry, run `pnpm sort-extensions`, open
the PR. `scripts/release.sh zed --yes` still works for tagging a version
checkpoint in this repo (useful for tracking which commit was submitted),
it just doesn't trigger any automated publish the way the other connectors'
tags do.

## Emacs package (`emacs/`) — build, test, release

Single-file package, `emacs/byteask.el`. No MELPA submission yet -- install
directly from this repo (see `emacs/README.md`'s "Install" section for the
`use-package :vc` / `package-vc-install` incantations).

```bash
cd emacs
emacs --batch -Q --eval "(setq byte-compile-error-on-warn t)" -f batch-byte-compile byteask.el
emacs --batch -Q --eval "(require 'checkdoc) (checkdoc-file \"byteask.el\")"
```

Both must be clean before this is MELPA-submission-ready (byte-compile:
zero warnings, not just zero errors; checkdoc: no output at all). A real
gotcha hit while building this: byte-compiling with `eat`/`vterm` (soft,
optional dependencies) NOT installed will warn that a `let`-binding of
`vterm-shell` is an unused lexical variable -- the byte-compiler has no way
to know it's meant to be a dynamically-scoped special variable from an
uninstalled package. Fixed with a local `(defvar vterm-shell)` declaration
(the standard idiom for this exact situation); don't remove it just because
`eat`/`vterm` happen to be installed on whatever machine you're compiling on.

Ships Tier 1 (`byteask` -- terminal session via `eat`/`vterm`/built-in
`ansi-term`) and Tier 2 (`byteask-exec`, `byteask-exec-region`,
`byteask-review`, `byteask-apply`, `byteask-resume[-last]`,
`byteask-fix-diagnostics` via Emacs's built-in Flymake). Tier 3 (a rich
streaming buffer + ediff-based approval, matching the JCEF/webview chat in
the other connectors) is a documented next goal, not yet built -- see
`emacs/README.md`'s "Known open items" for the precedent packages
(`gptel`, `claude-code-ide.el`) to build from.

Release: `scripts/release.sh emacs --yes` tags `emacs-vX.Y.Z` -- there is no
`emacs-publish.yml` (no automated channel exists to push to; MELPA
submission is a manual PR to `melpa/melpa` adding a recipe file, a separate,
future step). The tag is a version checkpoint for this repo, same as Zed's.
