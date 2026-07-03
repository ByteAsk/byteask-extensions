import { test as base, expect } from '@playwright/test';
import { buildHarnessHtml } from './harness.mjs';

export const test = base.extend({
  chat: async ({ page }, use) => {
    await page.setContent(buildHarnessHtml());
    // Let the page settle (fonts/layout) before any measurement-sensitive test runs.
    await page.waitForTimeout(50);
    await use(new ChatDriver(page));
  },
});

export { expect };

/** Thin wrapper around the harness page for readable test bodies. */
class ChatDriver {
  constructor(page) {
    this.page = page;
  }

  /** Simulate an extension -> webview message, exactly like `webview.postMessage()` does. */
  async post(message) {
    await this.page.evaluate((m) => window.postMessage(m, '*'), message);
  }

  async sendUserMessage(text) {
    await this.post({ type: 'userMessage', text });
  }

  /** Messages the webview sent back to the (simulated) extension via `vscode.postMessage`. */
  async sent() {
    return this.page.evaluate(() => window.__sent);
  }

  async scrollState() {
    return this.page.evaluate(() => {
      const m = document.getElementById('messages');
      return {
        scrollTop: m.scrollTop,
        scrollHeight: m.scrollHeight,
        clientHeight: m.clientHeight,
        distanceFromBottom: m.scrollHeight - m.scrollTop - m.clientHeight,
      };
    });
  }

  /**
   * Distance (px) from the top of the visible viewport to a selector's top
   * edge. Negative = above the fold. Takes the LAST matching element via
   * querySelectorAll -- `:last-of-type` is a trap here since the trailing
   * #scrollSpacer div (always the final child) matches `div` and disqualifies
   * every earlier div from `:last-of-type`, regardless of its class.
   */
  async distanceFromViewportTop(selector) {
    return this.page.evaluate((sel) => {
      const m = document.getElementById('messages');
      const matches = document.querySelectorAll(sel);
      const el = matches[matches.length - 1];
      if (!el) return null;
      const mRect = m.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      return elRect.top - mRect.top;
    }, selector);
  }

  /**
   * Visible empty space (px), within the current viewport, between the
   * bottom edge of the last matching element and the bottom edge of the
   * scrollable container. This is deliberately NOT `scrollHeight -
   * scrollTop - clientHeight` ("distance to the true end of all content") --
   * the anchor-spacer reserve is sized to ~clientHeight, so once a message
   * is anchored near the top, the reserve's tail sits right at (or just
   * past) the viewport's own bottom edge and there is barely any content
   * beyond the fold at all. What the feature actually promises is a big
   * visually-empty gap *on screen* below the message, which is what this
   * measures.
   */
  async visibleGapBelow(selector) {
    return this.page.evaluate((sel) => {
      const m = document.getElementById('messages');
      const matches = document.querySelectorAll(sel);
      const el = matches[matches.length - 1];
      if (!el) return null;
      const mRect = m.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      return mRect.bottom - elRect.bottom;
    }, selector);
  }

  /** Rendered height (px) of the scroll-anchor spacer, or 0 if absent. */
  async spacerHeight() {
    return this.page.evaluate(() => {
      const s = document.getElementById('scrollSpacer');
      return s ? s.offsetHeight : 0;
    });
  }

  async waitForRaf() {
    await this.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  }
}
