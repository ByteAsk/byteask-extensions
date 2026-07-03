# byteask.el

Drive [ByteAsk](https://byteask.ai) — the C/C++ agentic coding harness — from Emacs.

> ### 💬 Join the community
> **[discord.gg/vx5Eu4YNzG](https://discord.gg/vx5Eu4YNzG)** — community support, direct
> access to the team, and the fastest way to report an issue. Direct email:
> **anirudha@byteask.ai**.

[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/vx5Eu4YNzG)

## Commands

| Command | CLI mapping |
|---|---|
| `M-x byteask` | interactive TUI in a terminal (backend: `eat`/`vterm` if present, else built-in `ansi-term`) |
| `M-x byteask-exec` | `byteask exec <prompt>` — prompts for the instruction |
| `M-x byteask-exec-region` | `byteask exec` with the active region appended as context |
| `M-x byteask-fix-diagnostics` | formats this buffer's **Flymake** diagnostics into a prompt and runs `exec` |
| `M-x byteask-review` | `byteask review` |
| `M-x byteask-apply` | `byteask apply` — no `-m`/`-c` flags, it rejects them |
| `M-x byteask-resume` / `byteask-resume-last` | resume a previous session |

Same connector contract as vscode-byteask/byteask.nvim/byteask-jetbrains —
see the [repo README](../README.md#connector-contract).

## Requires

The `byteask` CLI on `PATH`:

```bash
pip install --upgrade byteask
byteask login
byteask doctor
```

## Install

No MELPA submission yet — install directly from this repo (Emacs 30+):

```elisp
(use-package byteask
  :vc (:url "https://github.com/ByteAsk/byteask-extensions" :lisp-dir "emacs"))
```

Emacs 29.1–29.x: `package-vc-install` with the same URL/lisp-dir. Older
Emacs, or `straight.el` users: point straight at the same repo with
`:files ("emacs/byteask.el")`.

## Settings

```elisp
(setq byteask-command "byteask")     ; path to the executable
(setq byteask-model "")               ; passed via -m; empty = byteask's own default
(setq byteask-extra-args nil)         ; e.g. '("-c" "key=value")
(setq byteask-auto-apply nil)         ; run `byteask apply` after a successful exec
(setq byteask-terminal-backend 'auto) ; 'auto | 'eat | 'vterm | 'ansi-term
```

## Development

```bash
emacs --batch -Q --eval "(setq byte-compile-error-on-warn nil)" -f batch-byte-compile byteask.el
emacs --batch -Q --eval "(require 'checkdoc) (checkdoc-file \"byteask.el\")"
```

Both must be clean (byte-compile: zero warnings; checkdoc: no output) before
a MELPA submission would have a chance — see the connector roadmap for the
full submission checklist (`package-lint`, `melpazoid`, a MELPA `recipe`
PR).

## Known open items

- **Tier 3 (a rich streaming buffer with ediff-based approval, matching the
  other connectors' JCEF/webview chat) is not built yet.** This ships Tier 1
  (terminal) + Tier 2 (headless exec/review/apply/fix-diagnostics) — a
  complete, useful package on its own, following the same phased approach
  (G1 → G2 → G3) as the other connectors. Precedent for the Tier-3 build:
  `gptel` (async streaming pattern), `claude-code-ide.el` (ediff-based
  approval).
- Not yet published to MELPA — install via `use-package :vc` /
  `package-vc-install` in the meantime (see "Install" above), which is a
  legitimate, common distribution path on its own.

## License

Apache-2.0
