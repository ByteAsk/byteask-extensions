# Canonical ByteAsk brand assets

`icon.png` / `icon.svg` are the single source of truth for the ByteAsk mark
(teal `#7AAFA5` background, white glyph) used across every connector's
Marketplace/store icon. Don't hand-recreate or independently edit copies —
if the brand icon changes, regenerate here first, then copy into each
connector:

```bash
cp assets/icon.png vscode-byteask/icon.png
# JetBrains needs an SVG sized for its pluginIcon.svg convention (viewBox
# stays 1024x1024, only width/height change):
sed 's/width="1024.000000pt" height="1024.000000pt"/width="40" height="40"/' \
  assets/icon.svg > jetbrains/src/main/resources/META-INF/pluginIcon.svg
```

Note: this is the two-tone *brand* icon (fixed teal background), not the
transparent single-color glyph used for VS Code's Activity Bar icon
(`vscode-byteask/media/icon.svg`) — that one has to stay a bare
`currentColor` outline with no background, since VS Code renders
activity-bar icons as a monochrome alpha mask and discards any actual
fill/background. See that file's own comment for why.
