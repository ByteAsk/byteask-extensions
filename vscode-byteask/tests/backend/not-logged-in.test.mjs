// Regression test for the second "byteask is unreachable" failure mode:
// the CLI is installed and runs fine, but nobody's logged in. Verified live
// against the real binary: `byteask app-server` refuses to even start in
// that state -- it prints "You're not signed in to ByteAsk. Run: byteask
// login --email you@company.com" to stderr and exits with code 1, before
// any JSON-RPC handshake happens. That message used to be silently dropped
// (AppServerRpc only forwarded stderr lines to a handler that
// chatViewProvider.ts doesn't attach until AFTER construction, so a
// message this fast never reached anything), and the resulting rejection
// was a generic "byteask app-server exited" with no way for the UI to tell
// "not logged in" apart from "not installed" or a real crash.
//
// This drives the REAL, currently-installed `byteask` binary (skips
// gracefully if one isn't on PATH -- e.g. a CI runner that never installs
// it) against an ISOLATED, empty BYTEASK_HOME created fresh in a temp dir,
// so this never touches the developer's real ~/.byteask or their actual
// login session. Runs the ACTUAL compiled output, same as
// cli-not-found.test.mjs.
//
// Run with: node tests/backend/not-logged-in.test.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', '..', 'out');

const { AppServerClient } = require(path.join(outDir, 'appServer', 'client.js'));

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

const probe = spawnSync('byteask', ['--version'], { stdio: 'ignore' });
if (probe.error) {
  console.log('SKIPPED: byteask is not installed in this environment (nothing to verify this against).');
  process.exit(0);
}

// A fresh, empty BYTEASK_HOME -- no auth.json / config.toml token of any
// kind -- so `byteask app-server` sees a genuinely logged-out state,
// regardless of whatever the real developer running this test is logged
// into on their own machine.
const isolatedHome = mkdtempSync(path.join(tmpdir(), 'byteask-test-home-'));
writeFileSync(
  path.join(isolatedHome, 'config.toml'),
  [
    'model = "gpt-5.4"',
    'model_provider = "byteask"',
    '',
    '[model_providers.byteask]',
    'name = "ByteAsk"',
    'base_url = "https://code.byteask.ai/byteask/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n')
);
writeFileSync(path.join(isolatedHome, 'gateway'), 'https://code.byteask.ai');

const noopCallbacks = {
  onItemStarted() {},
  onItemCompleted() {},
  onAgentMessageDelta() {},
  onReasoningTextDelta() {},
  onTurnDiffUpdated() {},
  onTurnStarted() {},
  onTurnCompleted() {},
  onError() {},
  onFileChangeApprovalRequest: async () => ({ decision: 'decline' }),
  onCommandExecutionApprovalRequest: async () => ({ decision: 'decline' }),
  onToolRequestUserInput: async () => ({ answers: {} }),
};

async function testNotLoggedInIsDetectedAndDistinct() {
  console.log('AppServerClient.connect against a fresh, logged-out BYTEASK_HOME');
  const previousHome = process.env.BYTEASK_HOME;
  process.env.BYTEASK_HOME = isolatedHome; // spawn() inherits process.env when none is passed explicitly
  let rejected = false;
  let isNotLoggedIn = false;
  let isCliNotFound = false;
  let message = '';
  const start = Date.now();
  try {
    await AppServerClient.connect('byteask', process.cwd(), noopCallbacks);
  } catch (err) {
    rejected = true;
    isNotLoggedIn = AppServerClient.isNotLoggedInError(err);
    isCliNotFound = AppServerClient.isCliNotFoundError(err);
    message = err instanceof Error ? err.message : String(err);
  } finally {
    if (previousHome === undefined) delete process.env.BYTEASK_HOME;
    else process.env.BYTEASK_HOME = previousHome;
  }
  const elapsedMs = Date.now() - start;
  check('connect() rejected instead of hanging until the 10s timeout', rejected);
  check('rejected fast (real behavior, not the 10s fallback timeout)', elapsedMs < 3000);
  check('the real stderr message made it into the rejection', /not signed in/i.test(message));
  check('AppServerClient.isNotLoggedInError() correctly identifies it', isNotLoggedIn);
  check('NOT misidentified as isCliNotFoundError (the binary DOES exist and run)', !isCliNotFound);
}

function testDetectorsDoNotOverlap() {
  console.log('isNotLoggedInError / isCliNotFoundError: must not both fire for the same real errors');
  const enoent = Object.assign(new Error('spawn byteask ENOENT'), { code: 'ENOENT' });
  check('an ENOENT error is NOT reported as not-logged-in', !AppServerClient.isNotLoggedInError(enoent));
  const generic = new Error('byteask app-server exited (code 1): some unrelated crash');
  check('a generic crash is NOT reported as not-logged-in', !AppServerClient.isNotLoggedInError(generic));
}

try {
  await testNotLoggedInIsDetectedAndDistinct();
  testDetectorsDoNotOverlap();
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
