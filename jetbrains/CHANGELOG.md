# ByteAsk for JetBrains Changelog

## [Unreleased]

### Added

- Initial scaffold: Open ByteAsk Terminal, Exec, Exec on Selection, Fix
  Diagnostics in Active File, Review Repository, Apply Latest Diff, Resume
  Last Session, and Resume Session commands under Tools → ByteAsk.
- Settings page (Settings → Tools → ByteAsk) for `command`, `model`,
  `extraArgs`, and `autoApply`.
- A ByteAsk tool window streaming headless-run output.
- A rich streaming chat sidebar ("ByteAsk Chat" tool window), JCEF-hosted,
  reusing vscode-byteask's chat.html/chat.css/chat.js unchanged: streaming
  responses, file-change/command approval cards, the multi-choice question
  tool, and CLI-not-found/not-signed-in onboarding cards.
