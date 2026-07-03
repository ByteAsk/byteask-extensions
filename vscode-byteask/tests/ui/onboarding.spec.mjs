// Regression suite for the two "byteask is unreachable" onboarding cards:
// CLI not installed, and CLI installed but not signed in. Both share one DOM
// card (mode-driven title/body/buttons/manual-instructions) since they're
// mutually exclusive states with the same shape (a blocking precondition,
// a one-click fix, a manual fallback, a retry).
//
// Real bugs this guards the UI contract for:
//  - chatViewProvider.ts used to spawn `byteask app-server` with no `error`
//    listener on the child process -- Node's ChildProcess special-cases an
//    unlistened 'error' event by RE-THROWING it as an uncaught exception
//    (verified live: crashes the whole extension host). Covered on the
//    backend side by tests/backend/cli-not-found.test.mjs, which spawns a
//    real, deliberately-missing binary the same way rpc.ts does.
//  - `byteask app-server` refuses to even start when nobody's logged in --
//    it prints "You're not signed in to ByteAsk. Run: byteask login ..." to
//    stderr and exits (code 1) *before* any JSON-RPC handshake, often before
//    the extension has even attached a stderr handler. Verified live against
//    the real binary with an isolated, empty BYTEASK_HOME.
// This suite covers the CONTRACT once the backend reports either case
// gracefully: does the webview show the right dedicated card (not a raw
// error string, not the wrong card), do the buttons post the right
// messages, and does the card clear correctly once byteask becomes
// reachable.
import { test, expect } from './fixtures.mjs';

test.describe('cli-not-found onboarding', () => {
  test('shows the onboarding card, not the normal welcome screen or a raw error', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });

    await expect(chat.page.locator('#onboarding')).toBeVisible();
    await expect(chat.page.locator('#obTitle')).toHaveText('ByteAsk CLI not found');
    await expect(chat.page.locator('#welcome')).toHaveClass(/hidden/);
    await expect(chat.page.locator('#messages')).toHaveClass(/hidden/);
    // Not rendered as a generic error bubble -- this is a dedicated card, not
    // "Failed to reach byteask: spawn byteask ENOENT" dumped as message text.
    await expect(chat.page.locator('.msg.error')).toHaveCount(0);
  });

  test('clicking the primary button posts installCli', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });
    await expect(chat.page.locator('#obPrimaryBtn')).toHaveText('Install ByteAsk');
    await chat.page.locator('#obPrimaryBtn').click();

    const sent = await chat.sent();
    expect(sent.find((m) => m.type === 'installCli')).toBeTruthy();
    // Clicking Install doesn't optimistically dismiss the card -- only a
    // real connected confirmation should do that.
    await expect(chat.page.locator('#onboarding')).toBeVisible();
  });

  test('clicking "Retry" posts retryConnect', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });
    await chat.page.locator('#obRetryBtn').click();

    const sent = await chat.sent();
    expect(sent.find((m) => m.type === 'retryConnect')).toBeTruthy();
  });

  test('a connected confirmation hides the card and restores the welcome screen', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });
    await expect(chat.page.locator('#onboarding')).toBeVisible();

    await chat.post({ type: 'connected' });

    await expect(chat.page.locator('#onboarding')).toHaveClass(/hidden/);
    await expect(chat.page.locator('#welcome')).toBeVisible();
  });

  test('a retry that still fails re-shows the card rather than a raw error bubble', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });
    await chat.page.locator('#obRetryBtn').click();
    // Extension host re-attempts, still can't find the CLI, reports the same way.
    await chat.post({ type: 'cliNotFound' });

    await expect(chat.page.locator('#onboarding')).toBeVisible();
    await expect(chat.page.locator('.msg.error')).toHaveCount(0);
  });

  test('the manual install options list curl, npm, and pip, and each is copyable', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });
    const details = chat.page.locator('#obManual');
    await details.locator('summary').click();
    await expect(chat.page.locator('#obManualInstall')).toBeVisible();
    await expect(chat.page.locator('#obManualLogin')).toHaveClass(/hidden/);

    const cmds = chat.page.locator('#obManualInstall .ob-manual-cmd');
    await expect(cmds).toHaveCount(3);
    await expect(cmds.nth(0)).toContainText('curl');
    await expect(cmds.nth(1)).toContainText('npm');
    await expect(cmds.nth(2)).toContainText('pip');

    await cmds.nth(1).click();
    const copied = await chat.page.evaluate(() => window.__clipboard);
    expect(copied).toBe('npm install -g @byteask/cli');
    await expect(cmds.nth(1)).toHaveClass(/copied/);
  });

  test('an unrelated error (not CLI-missing) still renders as a normal error bubble, not onboarding', async ({ chat }) => {
    await chat.post({ type: 'error', message: 'Failed to reach byteask: some other failure' });

    await expect(chat.page.locator('#onboarding')).toHaveClass(/hidden/);
    await expect(chat.page.locator('.msg.error')).toBeVisible();
  });

  test('the thinking indicator is dismissed when the onboarding card appears', async ({ chat }) => {
    await chat.post({ type: 'turnStarted' });
    await expect(chat.page.locator('#thinking')).not.toHaveClass(/hidden/);

    await chat.post({ type: 'cliNotFound' });
    await expect(chat.page.locator('#thinking')).toHaveClass(/hidden/);
  });
});

test.describe('not-logged-in onboarding', () => {
  test('shows a distinct "not signed in" card, not the CLI-missing one', async ({ chat }) => {
    await chat.post({ type: 'notLoggedIn' });

    await expect(chat.page.locator('#onboarding')).toBeVisible();
    await expect(chat.page.locator('#obTitle')).toHaveText('Not signed in to ByteAsk');
    await expect(chat.page.locator('#obTitle')).not.toHaveText('ByteAsk CLI not found');
    await expect(chat.page.locator('.msg.error')).toHaveCount(0);
  });

  test('the primary button reads "Log in" and posts the login message', async ({ chat }) => {
    await chat.post({ type: 'notLoggedIn' });

    await expect(chat.page.locator('#obPrimaryBtn')).toHaveText('Log in');
    await chat.page.locator('#obPrimaryBtn').click();

    const sent = await chat.sent();
    expect(sent.find((m) => m.type === 'login')).toBeTruthy();
    expect(sent.find((m) => m.type === 'installCli')).toBeFalsy();
  });

  test('the manual section shows the login command, not the install commands', async ({ chat }) => {
    await chat.post({ type: 'notLoggedIn' });
    await chat.page.locator('#obManual summary').click();

    await expect(chat.page.locator('#obManualLogin')).toBeVisible();
    await expect(chat.page.locator('#obManualInstall')).toHaveClass(/hidden/);
    await expect(chat.page.locator('#obManualLogin .ob-manual-cmd')).toHaveText('byteask login --email you@company.com');
  });

  test('Retry still works the same way as the CLI-missing card', async ({ chat }) => {
    await chat.post({ type: 'notLoggedIn' });
    await chat.page.locator('#obRetryBtn').click();

    const sent = await chat.sent();
    expect(sent.find((m) => m.type === 'retryConnect')).toBeTruthy();
  });

  test('switching from cliNotFound to notLoggedIn (e.g. after installing) updates the card in place', async ({ chat }) => {
    await chat.post({ type: 'cliNotFound' });
    await expect(chat.page.locator('#obTitle')).toHaveText('ByteAsk CLI not found');

    await chat.post({ type: 'notLoggedIn' });
    await expect(chat.page.locator('#obTitle')).toHaveText('Not signed in to ByteAsk');
    await expect(chat.page.locator('#obPrimaryBtn')).toHaveText('Log in');
    await expect(chat.page.locator('#onboarding')).toBeVisible();
  });

  test('a connected confirmation hides the not-signed-in card too', async ({ chat }) => {
    await chat.post({ type: 'notLoggedIn' });
    await chat.post({ type: 'connected' });

    await expect(chat.page.locator('#onboarding')).toHaveClass(/hidden/);
    await expect(chat.page.locator('#welcome')).toBeVisible();
  });
});
