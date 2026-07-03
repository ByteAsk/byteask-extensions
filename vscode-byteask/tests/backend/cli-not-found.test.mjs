// Regression test for the crash bug this whole onboarding feature exists to
// replace: `AppServerRpc` used to spawn `byteask app-server` with no
// listener on the child process's 'error' event. Node special-cases an
// unlistened 'error' event on an EventEmitter by re-throwing it as an
// UNCAUGHT EXCEPTION -- verified live, this crashed the entire extension
// host the first time anyone opened the chat view without the CLI
// installed, before any of chatViewProvider.ts's try/catch blocks ever got a
// chance to run (the throw happens inside the child_process internals, on
// a fresh tick, well outside any of our own call stacks).
//
// This can't be exercised through the Playwright UI harness (that's the
// webview's JS in a browser; this bug lives in the extension host's Node
// process spawning a real child_process). Runs the ACTUAL compiled output
// (out/appServer/rpc.js, out/appServer/client.js) in a plain Node process --
// no `vscode` module dependency in either file, confirmed by grep -- so this
// is the real code path, not a reimplementation of it.
//
// Run with: node tests/backend/cli-not-found.test.mjs
// (requires `npm run compile` first; run.sh below does both)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', '..', 'out');

const { AppServerRpc } = require(path.join(outDir, 'appServer', 'rpc.js'));
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

const NONEXISTENT_BINARY = 'byteask-definitely-does-not-exist-on-this-machine-xyz';

async function testRawRpcDoesNotCrash() {
  console.log('AppServerRpc: spawning a nonexistent binary must not throw uncaught');
  // If the bug were still present, this line itself would crash the whole
  // Node process (uncaught exception), never reaching the check() calls
  // below -- there is no try/catch that could save us from that, which is
  // exactly the point: the assertion IS "the process is still alive after this".
  const rpc = new AppServerRpc(NONEXISTENT_BINARY, ['app-server'], process.cwd());
  let rejected = false;
  let rejectionIsEnoent = false;
  try {
    await rpc.request('initialize', {});
  } catch (err) {
    rejected = true;
    rejectionIsEnoent = err && err.code === 'ENOENT';
  }
  check('process is still alive (no uncaught exception)', true);
  check('request() rejected instead of hanging forever', rejected);
  check('rejection carries the real ENOENT code', rejectionIsEnoent);
  rpc.dispose();
}

async function testClientConnectRejectsCleanly() {
  console.log('AppServerClient.connect: must reject cleanly, not hang or crash');
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
  let rejected = false;
  let isCliNotFound = false;
  const start = Date.now();
  try {
    await AppServerClient.connect(NONEXISTENT_BINARY, process.cwd(), noopCallbacks);
  } catch (err) {
    rejected = true;
    isCliNotFound = AppServerClient.isCliNotFoundError(err);
  }
  const elapsedMs = Date.now() - start;
  check('connect() rejected instead of hanging until the 10s timeout', rejected);
  check('rejected FAST (real ENOENT, not the 10s fallback timeout)', elapsedMs < 2000);
  check('AppServerClient.isCliNotFoundError() correctly identifies it', isCliNotFound);
}

async function testGenuineOtherErrorIsNotMisreportedAsCliNotFound() {
  console.log('AppServerClient.isCliNotFoundError: must not misfire on unrelated errors');
  check('a plain Error is NOT reported as cli-not-found', !AppServerClient.isCliNotFoundError(new Error('some other failure')));
  check('a non-Error value is NOT reported as cli-not-found', !AppServerClient.isCliNotFoundError('just a string'));
}

await testRawRpcDoesNotCrash();
await testClientConnectRejectsCleanly();
await testGenuineOtherErrorIsNotMisreportedAsCliNotFound();

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
