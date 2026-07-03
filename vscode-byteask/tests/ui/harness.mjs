// Builds a real, browser-renderable page from the ACTUAL shipped
// media/chat.html + chat.css + chat.js -- not a hand-copied duplicate that
// could drift out of sync with what ships. Real layout (offsetTop,
// scrollHeight, clientHeight) requires a real browser, not jsdom (which
// doesn't do layout at all -- every metric would read 0), which is why this
// harness renders through Playwright's actual Chromium instead.
//
// Simulates the VS Code webview contract:
//   - `acquireVsCodeApi().postMessage(x)` (webview -> extension) is
//     recorded into `window.__sent` so tests can assert on it.
//   - Extension -> webview messages are simulated with a real
//     `window.postMessage(data, '*')`, which is exactly what
//     `webview.postMessage()` triggers inside the real webview's page --
///    chat.js's own `window.addEventListener('message', ...)` doesn't know
//     the difference.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.join(__dirname, '..', '..', 'media');

export function buildHarnessHtml() {
  const html = readFileSync(path.join(mediaDir, 'chat.html'), 'utf8');
  const css = readFileSync(path.join(mediaDir, 'chat.css'), 'utf8');
  const js = readFileSync(path.join(mediaDir, 'chat.js'), 'utf8');

  const stub = `
    <script>
      window.__sent = [];
      window.acquireVsCodeApi = function () {
        let state;
        return {
          postMessage: (msg) => { window.__sent.push(msg); },
          getState: () => state,
          setState: (s) => { state = s; },
        };
      };
      // The webview is normally sized by VS Code's panel; give it a fixed,
      // realistic sidebar-ish size so layout math (offsetTop, clientHeight)
      // is deterministic across test runs/environments.
      document.documentElement.style.width = '360px';
      document.documentElement.style.height = '640px';
    </script>
  `;

  let body = html
    // Drop the CSP meta -- irrelevant for a local test harness, and it
    // would otherwise block the inline <style>/<script> below.
    .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
    .replace(/<link href="\$\{styleUri\}" rel="stylesheet" \/>/, `<style>${css}</style>`)
    .replace(/<script nonce="\$\{nonce\}" src="\$\{scriptUri\}"><\/script>/, `${stub}<script>${js}</script>`);

  return body;
}
