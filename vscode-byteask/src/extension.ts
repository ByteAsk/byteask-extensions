// ByteAsk VS Code extension.
//
// Drives the `byteask` CLI:
//   • interactive / resume  → integrated terminal (needs a TTY)
//   • exec / review / apply → child_process streamed into an OutputChannel
//
// This mirrors byteask.nvim. A future revision can graduate to the structured
// `byteask app-server` protocol for inline diffs and approvals.

import * as vscode from 'vscode';
import { spawn } from 'child_process';

let terminal: vscode.Terminal | undefined;
let output: vscode.OutputChannel | undefined;

interface ByteAskConfig {
  command: string;
  model: string;
  extraArgs: string[];
  autoApply: boolean;
}

function getConfig(): ByteAskConfig {
  const c = vscode.workspace.getConfiguration('byteask');
  return {
    command: c.get<string>('command', 'byteask'),
    model: c.get<string>('model', ''),
    extraArgs: c.get<string[]>('extraArgs', []),
    autoApply: c.get<boolean>('autoApply', false),
  };
}

/** Common flags shared by every invocation (model, extra args). */
function commonFlags(cfg: ByteAskConfig): string[] {
  const flags: string[] = [];
  if (cfg.model) {
    flags.push('-m', cfg.model);
  }
  flags.push(...cfg.extraArgs);
  return flags;
}

function workspaceCwd(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function getOutput(): vscode.OutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('ByteAsk');
  }
  return output;
}

// ── Interactive terminal ────────────────────────────────────────────────────

function getTerminal(cfg: ByteAskConfig): vscode.Terminal {
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal({ name: 'ByteAsk', cwd: workspaceCwd() });
  }
  return terminal;
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function openTerminal(extra: string[] = []): void {
  const cfg = getConfig();
  const term = getTerminal(cfg);
  term.show();
  const argv = [cfg.command, ...commonFlags(cfg), ...extra];
  term.sendText(argv.map(shellQuote).join(' '));
}

// ── Headless runner ─────────────────────────────────────────────────────────

let headlessRunning = false;

/**
 * Run `byteask <subcommand...>` headless, streaming to the OutputChannel.
 * @param sub    subcommand + flags (e.g. ['exec', prompt] or ['review'])
 * @param title  short label for messages
 * @param applyAfter  run `byteask apply` when the run exits 0
 * @param withCommon  include model/-c/extra flags (false for `apply`, which rejects them)
 */
function runHeadless(sub: string[], title: string, applyAfter = false, withCommon = true): void {
  if (headlessRunning) {
    vscode.window.showWarningMessage('ByteAsk: a headless run is already in progress.');
    return;
  }
  const cfg = getConfig();
  const out = getOutput();
  out.show(true);

  // exec/review take common flags AFTER the subcommand so clap binds them right.
  const [head, ...rest] = sub;
  const argv = withCommon ? [head, ...commonFlags(cfg), ...rest] : [head, ...rest];
  out.appendLine(`$ ${cfg.command} ${argv.join(' ')}`);
  out.appendLine('');

  headlessRunning = true;
  const child = spawn(cfg.command, argv, { cwd: workspaceCwd() });

  child.stdout.on('data', (d: Buffer) => out.append(d.toString()));
  child.stderr.on('data', (d: Buffer) => out.append(d.toString()));

  child.on('error', (err) => {
    headlessRunning = false;
    out.appendLine(`\n[byteask ${title} failed to start: ${err.message}]`);
    vscode.window.showErrorMessage(
      `ByteAsk: could not run '${cfg.command}'. Is it installed and on PATH? (pip install --upgrade byteask)`,
    );
  });

  child.on('close', (code) => {
    headlessRunning = false;
    out.appendLine(`\n[byteask ${title} exited: ${code}]`);
    if (code === 0 && applyAfter) {
      applyDiff();
    } else if (code === 0) {
      vscode.window.showInformationMessage(`ByteAsk ${title} finished.`);
    } else {
      vscode.window.showWarningMessage(`ByteAsk ${title} exited with code ${code}.`);
    }
  });
}

function applyDiff(): void {
  runHeadless(['apply'], 'apply', false, false);
}

// ── Prompt-building commands ────────────────────────────────────────────────

async function execPrompt(): Promise<void> {
  const instruction = await vscode.window.showInputBox({
    prompt: 'ByteAsk exec — what should the agent do?',
    placeHolder: 'e.g. Add bounds checks and a unit test for parse_header()',
  });
  if (!instruction) {
    return;
  }
  runHeadless(['exec', instruction], 'exec', getConfig().autoApply);
}

async function execSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('ByteAsk: no selection.');
    return;
  }
  const selection = editor.document.getText(editor.selection);
  const instruction = await vscode.window.showInputBox({
    prompt: 'ByteAsk exec on selection — instruction',
    value: 'Improve this code.',
  });
  if (!instruction) {
    return;
  }
  const rel = vscode.workspace.asRelativePath(editor.document.uri);
  const prompt = `${instruction} (from ${rel})\n\n\`\`\`\n${selection}\n\`\`\``;
  runHeadless(['exec', prompt], 'exec', getConfig().autoApply);
}

const SEVERITY: Record<vscode.DiagnosticSeverity, string> = {
  [vscode.DiagnosticSeverity.Error]: 'ERROR',
  [vscode.DiagnosticSeverity.Warning]: 'WARN',
  [vscode.DiagnosticSeverity.Information]: 'INFO',
  [vscode.DiagnosticSeverity.Hint]: 'HINT',
};

function fixDiagnostics(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('ByteAsk: no active editor.');
    return;
  }
  const uri = editor.document.uri;
  const diags = vscode.languages.getDiagnostics(uri);
  if (diags.length === 0) {
    vscode.window.showInformationMessage('ByteAsk: no diagnostics in the active file.');
    return;
  }
  const rel = vscode.workspace.asRelativePath(uri);
  const block = diags
    .map(
      (d) =>
        `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}: ` +
        `${SEVERITY[d.severity]}: ${d.message.replace(/\n/g, ' ')}`,
    )
    .join('\n');
  const prompt =
    `Fix the following compiler/linter diagnostics in ${rel}. ` +
    `Make the minimal correct change and keep the build green:\n\n\`\`\`\n${block}\n\`\`\``;
  runHeadless(['exec', prompt], 'exec', getConfig().autoApply);
}

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('byteask.open', () => openTerminal());
  reg('byteask.resumeLast', () => openTerminal(['resume', '--last']));
  reg('byteask.resume', () => openTerminal(['resume']));
  reg('byteask.exec', () => execPrompt());
  reg('byteask.execSelection', () => execSelection());
  reg('byteask.review', () => runHeadless(['review'], 'review'));
  reg('byteask.apply', () => applyDiff());
  reg('byteask.fixDiagnostics', () => fixDiagnostics());

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        terminal = undefined;
      }
    }),
  );
}

export function deactivate(): void {
  terminal?.dispose();
  output?.dispose();
}
