// Regression suite for the "sending a message should anchor it near the top
// of the view, leaving room for the response to grow into" behavior.
//
// Real root cause this guards against: `el.offsetTop` is relative to
// `el.offsetParent` (nearest *positioned* ancestor), not necessarily the
// scrollable container -- and even with that fixed, a freshly-appended
// message is the LAST element in the list, so the browser has nowhere to
// scroll TO (scrollTop clamps to scrollHeight-clientHeight) unless something
// reserves room below it first. Both bugs are invisible in jsdom (no real
// layout) and easy to "fix" in a way that looks right by reading the code
// but does nothing in a real browser -- hence testing against real Chromium
// layout via Playwright instead of asserting on the JS logic in isolation.
import { test, expect } from './fixtures.mjs';

// Replies are deliberately long enough to exceed the reserved gap
// (~clientHeight-40, i.e. several hundred px) so each turn's spacer fully
// depletes by the end of it -- an unrealistically short reply leaving a
// lingering gap is CORRECT behavior (that's the point of the feature: a
// short answer doesn't need to force-fill the reserved space), not a bug,
// so tests that need a "caught up to the bottom" baseline must use long
// enough synthetic content to actually reach that state, same as a real
// multi-paragraph reply would.
async function fillWithConversation(chat, turns) {
  for (let i = 0; i < turns; i++) {
    await chat.sendUserMessage(`prior turn ${i}`);
    await chat.post({ type: 'turnStarted' });
    await chat.post({
      type: 'itemCompleted',
      item: {
        type: 'agentMessage',
        id: `reply-${i}`,
        text: `This is a long reply body for turn ${i}, repeated enough to fill the viewport. `.repeat(40),
        phase: 'final_answer',
        memoryCitation: null,
      },
    });
    await chat.post({ type: 'turnCompleted', status: 'completed' });
  }
}

test.describe('scroll-to-top-on-send', () => {
  test('sending a message in an ongoing conversation anchors it near the top of the view', async ({ chat }) => {
    await fillWithConversation(chat, 6);

    // Sanity: we should be scrolled to (or very near) the bottom after that
    // conversation, since maybeFollow() was sticky throughout.
    const before = await chat.scrollState();
    expect(before.distanceFromBottom).toBeLessThan(10);

    await chat.sendUserMessage('brand new message, should land near the top');
    await chat.waitForRaf();

    const distanceFromTop = await chat.distanceFromViewportTop('.msg.user');
    // "Near the top" -- allow a little slack for the 12px margin + rounding,
    // but this must NOT be sitting at the bottom of a ~500px viewport (which
    // is what the bug produced: distanceFromTop >= clientHeight - ~40px).
    expect(distanceFromTop).toBeGreaterThanOrEqual(0);
    expect(distanceFromTop).toBeLessThan(40);

    // And there must be a large empty gap below it, visible on screen --
    // the whole point (not "content remaining past the scrollable fold",
    // which is small by design since the reserve is sized to the viewport).
    const gap = await chat.visibleGapBelow('.msg.user');
    expect(gap).toBeGreaterThan(300);
  });

  test('the gap shrinks as the response streams in, without snapping to follow', async ({ chat }) => {
    await fillWithConversation(chat, 3);
    await chat.sendUserMessage('trigger a streamed response');
    await chat.waitForRaf();

    const afterSend = await chat.scrollState();
    const scrollTopAfterSend = afterSend.scrollTop;
    const spacerAfterSend = await chat.spacerHeight();
    expect(spacerAfterSend).toBeGreaterThan(200);

    await chat.post({ type: 'turnStarted' });
    await chat.post({
      type: 'itemStarted',
      item: { type: 'agentMessage', id: 'streamed-1', text: '', phase: 'final_answer', memoryCitation: null },
    });

    // Stream a chunky reply in pieces, like real token deltas.
    for (let i = 0; i < 15; i++) {
      await chat.post({ type: 'agentMessageDelta', itemId: 'streamed-1', delta: 'word '.repeat(8) });
    }

    const mid = await chat.scrollState();
    // scrollTop should stay essentially put (the view doesn't jump to
    // follow the stream -- the spacer absorbs the growth instead)...
    expect(Math.abs(mid.scrollTop - scrollTopAfterSend)).toBeLessThan(5);
    // ...while the reserved gap (the spacer) has visibly shrunk as real
    // content replaced it -- this, not the anchored user message's own
    // position (which never moves once anchored), is what the user
    // actually perceives filling in on screen.
    const spacerMid = await chat.spacerHeight();
    expect(spacerMid).toBeLessThan(spacerAfterSend);
  });

  test('a user who scrolled up to read history is not yanked back down by streaming content', async ({ chat }) => {
    await fillWithConversation(chat, 8);

    // Manually scroll away from the bottom, like a person reading earlier context.
    await chat.page.evaluate(() => {
      const m = document.getElementById('messages');
      m.scrollTop = 0;
      m.dispatchEvent(new Event('scroll'));
    });
    const scrolledUp = await chat.scrollState();
    expect(scrolledUp.scrollTop).toBe(0);

    // New content streams in from a background turn (not one this user
    // triggered by sending -- e.g. resumed history, or just more of an
    // ongoing turn while they've scrolled away).
    await chat.post({
      type: 'itemCompleted',
      item: { type: 'agentMessage', id: 'bg-1', text: 'more content while scrolled up', phase: 'final_answer', memoryCitation: null },
    });

    const after = await chat.scrollState();
    expect(after.scrollTop).toBe(0); // untouched
  });

  test('starting a new chat resets scroll/anchor state cleanly', async ({ chat }) => {
    await fillWithConversation(chat, 4);
    await chat.sendUserMessage('one more before clearing');
    await chat.waitForRaf();

    await chat.post({ type: 'cleared' });

    const state = await chat.scrollState();
    expect(state.scrollHeight).toBeLessThanOrEqual(state.clientHeight + 1);
    const spacerHeight = await chat.page.evaluate(() => {
      const s = document.getElementById('scrollSpacer');
      return s ? s.offsetHeight : 0;
    });
    expect(spacerHeight).toBe(0);
  });
});
