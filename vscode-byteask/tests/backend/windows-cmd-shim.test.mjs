// Regression test for the Windows install path: the official installer
// (install.ps1, which this extension's own onboarding runs) creates only
// `byteask.cmd` -- there is no `byteask.exe`. Node's spawn() does not
// consult PATHEXT or run batch files through a shell, so spawning `byteask`
// yields ENOENT, and passing the full .cmd path throws EINVAL synchronously.
// Result on Windows: the chat view shows "CLI not found" forever, even right
// after the extension's own install button succeeded, and every headless
// command fails the same way.
//
// This builds an isolated installer-shaped shim -- a directory containing
// only fake-cli.cmd plus its fake-cli.ps1 sibling -- and drives the REAL
// compiled AppServerClient against it. The .cmd deliberately exits 42, so a
// pass proves the CLI was reached through the .ps1, not by handing the .cmd
// to cmd.exe.
//
// Windows-only: on other platforms the extension spawns the CLI directly and
// this whole failure mode does not exist. Run with:
//   node tests/backend/windows-cmd-shim.test.mjs
// (requires `npm run compile` first)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', '..', 'out');

const { AppServerClient } = require(path.join(outDir, 'appServer', 'client.js'));
const { cliSpawnSpec } = require(path.join(outDir, 'cliCommand.js'));

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    console.error(`  FAIL - ${name}`);
    failures++;
  }
}

if (process.platform !== 'win32') {
  console.log('SKIPPED: Windows-only install layout (on other platforms the CLI is spawned directly).');
  process.exit(0);
}

const psProbe = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
if (psProbe.error) {
  console.log('SKIPPED: powershell.exe is not available in this environment.');
  process.exit(0);
}

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

// A directory name with a space, because installs outside %LOCALAPPDATA%
// (e.g. C:\Program Files\ByteAsk) are exactly the paths that break naive
// command-line construction.
const root = mkdtempSync(path.join(tmpdir(), 'byteask-cmd-shim-'));
const shimDir = path.join(root, 'Programs with space');
mkdirSync(shimDir, { recursive: true });

const payload = [
  "const fs = require('fs');",
  "const path = require('path');",
  "fs.writeFileSync(path.join(__dirname, 'argv.json'), JSON.stringify(process.argv.slice(2)));",
  'setTimeout(() => process.exit(0), 8000);',
  "process.stdin.setEncoding('utf8');",
  "let b = '';",
  'process.stdin.on("data", (d) => {',
  '  b += d;',
  '  let i;',
  '  while ((i = b.indexOf("\\n")) >= 0) {',
  '    const line = b.slice(0, i);',
  '    b = b.slice(i + 1);',
  '    let msg;',
  '    try { msg = JSON.parse(line); } catch { continue; }',
  '    if (msg.id !== undefined) process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + "\\n");',
  '  }',
  '});',
  'process.stdin.on("end", () => process.exit(0));',
  '',
].join('\n');
writeFileSync(path.join(shimDir, 'payload.js'), payload);

const ps1 = `& "${process.execPath}" "$PSScriptRoot\\payload.js" @args\n`;
writeFileSync(path.join(shimDir, 'fake-cli.ps1'), ps1);

// If anything hands this .cmd to cmd.exe instead of reaching the sibling
// .ps1, the connection dies here.
writeFileSync(path.join(shimDir, 'fake-cli.cmd'), '@echo off\r\nexit /b 42\r\n');

// Separate shim that reports the argv it received, so the tests can prove
// prompts survive verbatim (cmd.exe would eat %, &, ^ and truncate at \n).
// Embedded double quotes are deliberately absent: Windows PowerShell 5.1
// strips them when splatting to a native child, which the CLI's own
// .cmd/.ps1 shim does too -- that behavior is inherited, not introduced here.
writeFileSync(
  path.join(shimDir, 'args.js'),
  'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
);
writeFileSync(
  path.join(shimDir, 'args-cli.ps1'),
  `& "${process.execPath}" "$PSScriptRoot\\args.js" @args\n`,
);
writeFileSync(path.join(shimDir, 'args-cli.cmd'), '@echo off\r\nexit /b 42\r\n');

// A batch file with NO .ps1 sibling (not an official install shape). The
// resolver has to fall back to cmd.exe; the spaced parent directory proves
// the command line is quoted for `cmd /s /c`, which strips the outermost
// pair of quotes instead of handing the path to CreateProcess.
const noSiblingDir = path.join(root, 'No PS1 Sibling with space');
mkdirSync(noSiblingDir, { recursive: true });
const noSiblingCmd = path.join(noSiblingDir, 'plain-cli.cmd');
writeFileSync(noSiblingCmd, '@echo off\r\necho GOT:[%~1]\r\nexit /b 3\r\n');

const previousPath = process.env.PATH;
process.env.PATH = shimDir + path.delimiter + (previousPath ?? '');

async function connectAndCheck(label, command) {
  console.log(`${label}: ${command}`);
  let client;
  let error;
  try {
    client = await AppServerClient.connect(command, process.cwd(), noopCallbacks);
  } catch (err) {
    error = err;
  }
  check('connect() reached the CLI through its .ps1 sibling', !error);
  let argv = [];
  try {
    argv = JSON.parse(readFileSync(path.join(shimDir, 'argv.json'), 'utf8'));
  } catch {
    argv = [];
  }
  check('the CLI still received its real argument (app-server)', JSON.stringify(argv) === JSON.stringify(['app-server']));
  client?.dispose();
}

function testPromptArgumentsSurvive() {
  console.log('exec prompt arguments must arrive byte-for-byte');
  const args = ['exec', 'a&b', '100%PATH%', 'line1\nline2', 'a^b'];
  const spec = cliSpawnSpec('args-cli', args);
  const result = spawnSync(spec.command, spec.args, { encoding: 'utf8' });
  check('the shim ran successfully', result.status === 0);
  let received = [];
  try {
    received = JSON.parse((result.stdout ?? '').trim());
  } catch {
    received = [];
  }
  check('prompt arguments were not re-parsed or truncated', JSON.stringify(received) === JSON.stringify(args));
}

function testBatchWithoutPs1Sibling() {
  console.log('batch file with no .ps1 sibling, in a path containing a space');
  const spec = cliSpawnSpec(noSiblingCmd, ['app-server']);
  const result = spawnSync(spec.command, spec.args, {
    encoding: 'utf8',
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  check('the batch file was reached (not split at the space)', (result.stdout ?? '').includes('GOT:[app-server]'));
  check('its exit code came through', result.status === 3);

  // An argument with spaces must be preserved as a single argument
  const spaceSpec = cliSpawnSpec(noSiblingCmd, ['two words']);
  const spaceResult = spawnSync(spaceSpec.command, spaceSpec.args, {
    encoding: 'utf8',
    windowsVerbatimArguments: spaceSpec.windowsVerbatimArguments,
  });
  check('argument with space was preserved intact', (spaceResult.stdout ?? '').includes('GOT:[two words]'));

  // An empty argument must not be dropped
  const emptySpec = cliSpawnSpec(noSiblingCmd, ['']);
  const emptyResult = spawnSync(emptySpec.command, emptySpec.args, {
    encoding: 'utf8',
    windowsVerbatimArguments: emptySpec.windowsVerbatimArguments,
  });
  check('empty argument was preserved', (emptyResult.stdout ?? '').includes('GOT:[]'));
}

try {
  await connectAndCheck('bare command resolved via PATH', 'fake-cli');
  await connectAndCheck('absolute .cmd path from the byteask.command setting', path.join(shimDir, 'fake-cli.cmd'));
  await connectAndCheck('absolute path without extension', path.join(shimDir, 'fake-cli'));
  await connectAndCheck('quoted absolute .cmd path', `"${path.join(shimDir, 'fake-cli.cmd')}"`);
  testPromptArgumentsSurvive();
  testBatchWithoutPs1Sibling();
} finally {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
