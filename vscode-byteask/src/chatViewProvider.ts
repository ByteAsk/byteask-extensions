// Sidebar webview chat panel, driven by `byteask app-server` instead of the
// terminal/spawn CLI wrapper the rest of this extension uses. This is the
// primary, graphical entry point — see appServer/client.ts for the protocol
// client and appServer/generated/ for the (vendored, type-only) wire types.
//
// Storage note: this file persists NOTHING of its own. Every notion of
// "which thread is active" or "what happened before" is a live query against
// the single real session store the CLI/TUI/exec/this-extension all already
// share (~/.byteask, i.e. whatever `codexHome` resolves to) via
// `thread/list`/`thread/resume`. There is no separate database, no cached
// transcript file, nothing that could drift out of sync with the real thing.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { AppServerClient } from './appServer/client';
import type { ThreadItem } from './appServer/generated/v2/ThreadItem';
import type { FileChangeRequestApprovalParams } from './appServer/generated/v2/FileChangeRequestApprovalParams';
import type { FileChangeApprovalDecision } from './appServer/generated/v2/FileChangeApprovalDecision';
import type { CommandExecutionRequestApprovalParams } from './appServer/generated/v2/CommandExecutionRequestApprovalParams';
import type { CommandExecutionApprovalDecision } from './appServer/generated/v2/CommandExecutionApprovalDecision';
import type { UserInput } from './appServer/generated/v2/UserInput';
import type { ThreadResumeResponse } from './appServer/generated/v2/ThreadResumeResponse';
import type { ToolRequestUserInputParams } from './appServer/generated/v2/ToolRequestUserInputParams';
import type { ToolRequestUserInputResponse } from './appServer/generated/v2/ToolRequestUserInputResponse';

interface PendingApproval {
  resolve: (decision: string) => void;
}

interface PendingUserInput {
  resolve: (response: ToolRequestUserInputResponse) => void;
}

interface Attachment {
  path: string;
  name: string;
  kind: 'image' | 'text';
  content?: string; // only for kind: 'text'
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'byteask.chatView';

  private view?: vscode.WebviewView;
  private client?: AppServerClient;
  private threadId?: string;
  private currentTurnId?: string;
  private turnInProgress = false;

  private readonly cachedItems = new Map<string, ThreadItem>();
  private readonly pendingApprovals = new Map<number, PendingApproval>();
  private readonly approvalDiffText = new Map<number, string>();
  private nextApprovalId = 1;
  private readonly pendingUserInputs = new Map<number, PendingUserInput>();
  private nextUserInputId = 1;
  /** Set via the "/" > "Switch model..." command; applied to future turns/threads. */
  private pinnedModel?: string;

  private output: vscode.OutputChannel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    output: vscode.OutputChannel
  ) {
    this.output = output;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.handleWebviewMessage(msg));
    void this.autoResumeLatest();
  }

  /** Reveal the view (used by the `byteask.chat.focus` command). */
  reveal(): void {
    // VS Code auto-generates a `<viewId>.focus` command for every registered view.
    void vscode.commands.executeCommand('byteask.chatView.focus');
  }

  /** Used by the `byteask.chat.newThread` view-title command. */
  newThread(): void {
    void this.startNewThread();
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.html');
    let html = fs.readFileSync(htmlPath.fsPath, 'utf8');
    html = html
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{scriptUri\}/g, scriptUri.toString())
      .replace(/\$\{styleUri\}/g, styleUri.toString());
    return html;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private workspaceCwd(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
  }

  private async ensureClient(): Promise<AppServerClient> {
    if (this.client) {
      return this.client;
    }
    const command = vscode.workspace.getConfiguration('byteask').get<string>('command', 'byteask');
    this.client = await AppServerClient.connect(command, this.workspaceCwd(), {
      onItemStarted: (n) => {
        this.cachedItems.set(n.item.id, n.item);
        this.forwardItem('itemStarted', n.item);
      },
      onItemCompleted: (n) => {
        this.cachedItems.set(n.item.id, n.item);
        this.forwardItem('itemCompleted', n.item);
      },
      onAgentMessageDelta: (n) => this.post({ type: 'agentMessageDelta', itemId: n.itemId, delta: n.delta }),
      onReasoningTextDelta: (n) => this.post({ type: 'reasoningDelta', itemId: n.itemId, delta: n.delta }),
      onTurnDiffUpdated: () => {
        /* v1 renders per-item diffs on the approval card instead; no-op here */
      },
      onTurnStarted: (n) => {
        this.currentTurnId = n.turn.id;
        this.turnInProgress = true;
        this.post({ type: 'turnStarted' });
      },
      onTurnCompleted: (n) => {
        this.turnInProgress = false;
        this.post({ type: 'turnCompleted', status: n.turn.status });
      },
      onError: (n) => this.post({ type: 'error', message: n.error.message }),
      onFileChangeApprovalRequest: (p) => this.requestFileChangeApproval(p),
      onCommandExecutionApprovalRequest: (p) => this.requestCommandApproval(p),
      onToolRequestUserInput: (p) => this.requestUserInput(p),
    });
    this.client.setStderrHandler((line) => this.output.appendLine('[app-server] ' + line));
    return this.client;
  }

  /**
   * Every call site that talks to `byteask app-server` funnels its failure
   * through here so "the CLI isn't installed" or "nobody's logged in"
   * always gets the same dedicated onboarding card in the webview --
   * regardless of whether the user triggered it by sending a message,
   * opening history, switching models, etc. -- instead of 7 different raw
   * error strings depending on which action happened to be first.
   */
  private reportUnreachable(err: unknown, context: string): void {
    if (AppServerClient.isCliNotFoundError(err)) {
      this.post({ type: 'cliNotFound' });
      return;
    }
    if (AppServerClient.isNotLoggedInError(err)) {
      this.post({ type: 'notLoggedIn' });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    this.post({ type: 'error', message: `${context}: ${message}` });
  }

  private forwardItem(kind: 'itemStarted' | 'itemCompleted', item: ThreadItem): void {
    if (item.type === 'fileChange') {
      this.output.appendLine(`[chat] ${kind} fileChange id=${item.id} status=${item.status}`);
    }
    // Only forward the item kinds the webview knows how to render; unknown
    // kinds (collabAgentToolCall, subAgentActivity, etc.) are skipped in v1.
    this.post({ type: kind, item });
  }

  private buildFileChangeDiffText(itemId: string): string {
    const item = this.cachedItems.get(itemId);
    if (!item || item.type !== 'fileChange') {
      return '(diff not available)';
    }
    return item.changes.map((c) => `--- ${c.path}\n+++ ${c.path}\n${c.diff}`).join('\n\n');
  }

  private buildFileChangeSummary(itemId: string): string {
    const item = this.cachedItems.get(itemId);
    if (!item || item.type !== 'fileChange') {
      return 'Proposed file change';
    }
    return item.changes.map((c) => `${c.kind.type} ${path.basename(c.path)}`).join(', ');
  }

  private requestFileChangeApproval(p: FileChangeRequestApprovalParams): Promise<FileChangeApprovalDecision> {
    this.output.appendLine(`[chat] item/fileChange/requestApproval received for itemId=${p.itemId}`);
    const requestId = this.nextApprovalId++;
    const diffText = this.buildFileChangeDiffText(p.itemId);
    this.approvalDiffText.set(requestId, diffText);
    this.post({
      type: 'approvalRequest',
      requestId,
      kind: 'fileChange',
      title: this.buildFileChangeSummary(p.itemId),
      body: diffText,
    });
    return new Promise<string>((resolve) => {
      this.pendingApprovals.set(requestId, { resolve });
    }) as Promise<FileChangeApprovalDecision>;
  }

  private requestCommandApproval(p: CommandExecutionRequestApprovalParams): Promise<CommandExecutionApprovalDecision> {
    this.output.appendLine(`[chat] item/commandExecution/requestApproval received: ${p.command ?? '(unknown)'}`);
    const requestId = this.nextApprovalId++;
    const command = p.command ?? '(unknown command)';
    this.post({
      type: 'approvalRequest',
      requestId,
      kind: 'command',
      title: command,
      body: p.cwd ? `cwd: ${p.cwd}` : '',
    });
    return new Promise<string>((resolve) => {
      this.pendingApprovals.set(requestId, { resolve });
    }) as Promise<CommandExecutionApprovalDecision>;
  }

  /** The multi-choice "ask the user a question" tool (Claude Code's AskUserQuestion equivalent). */
  private requestUserInput(p: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse> {
    this.output.appendLine(`[chat] item/tool/requestUserInput received for itemId=${p.itemId}, ${p.questions.length} question(s)`);
    const requestId = this.nextUserInputId++;
    this.post({
      type: 'userInputRequest',
      requestId,
      questions: p.questions,
    });
    return new Promise<ToolRequestUserInputResponse>((resolve) => {
      this.pendingUserInputs.set(requestId, { resolve });
    });
  }

  private async handleWebviewMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'sendMessage':
        await this.sendMessage(String(msg.text ?? ''), msg.attachment as Attachment | null | undefined);
        break;
      case 'approvalDecision': {
        const requestId = Number(msg.requestId);
        const decision = String(msg.decision);
        this.pendingApprovals.get(requestId)?.resolve(decision);
        this.pendingApprovals.delete(requestId);
        break;
      }
      case 'userInputAnswer': {
        const requestId = Number(msg.requestId);
        const answers = msg.answers as Record<string, { answers: string[] }>;
        this.pendingUserInputs.get(requestId)?.resolve({ answers });
        this.pendingUserInputs.delete(requestId);
        break;
      }
      case 'userInputCancel': {
        const requestId = Number(msg.requestId);
        this.pendingUserInputs.get(requestId)?.resolve({ answers: {} });
        this.pendingUserInputs.delete(requestId);
        break;
      }
      case 'viewDiff': {
        const requestId = Number(msg.requestId);
        const text = this.approvalDiffText.get(requestId) ?? '(diff not available)';
        const doc = await vscode.workspace.openTextDocument({ content: text, language: 'diff' });
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case 'openFile':
        await this.openFile(String(msg.path ?? ''));
        break;
      case 'interrupt':
        if (this.client && this.threadId && this.currentTurnId && this.turnInProgress) {
          await this.client.turnInterrupt({ threadId: this.threadId, turnId: this.currentTurnId });
        }
        break;
      case 'newThread':
        await this.startNewThread();
        break;
      case 'listSessions':
        await this.listSessions();
        break;
      case 'resumeThread':
        await this.resumeThreadById(String(msg.threadId ?? ''));
        break;
      case 'uploadFile':
        await this.uploadFile();
        break;
      case 'mentionFile':
        await this.mentionFile();
        break;
      case 'switchModel':
        await this.switchModel();
        break;
      case 'showStatus':
        this.showStatus();
        break;
      case 'showUsage':
        await this.showUsage();
        break;
      case 'showDiff':
        await this.showDiff();
        break;
      case 'showSkills':
        await this.showSkills();
        break;
      case 'login':
        this.openAuthTerminal('login');
        break;
      case 'logout':
        this.openAuthTerminal('logout');
        break;
      case 'installCli':
        this.installCli();
        break;
      case 'retryConnect':
        await this.retryConnect();
        break;
      default:
        break;
    }
  }

  /** Open a file path mentioned in an assistant message (e.g. "Edited
   * [hello.txt](/abs/path)"). Not ACP-related -- the hand-rolled markdown
   * renderer just emits a plain `<a href>` for `[text](path)`, and a webview
   * has no way to navigate to an arbitrary filesystem path on click; this is
   * the client-side click interception + a real editor open to make that
   * link actually do something. */
  private async openFile(rawPath: string): Promise<void> {
    if (!rawPath) {
      return;
    }
    const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(this.workspaceCwd(), rawPath);
    try {
      const doc = await vscode.workspace.openTextDocument(resolved);
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`ByteAsk: could not open '${rawPath}': ${message}`);
    }
  }

  // ── "+" / "/" menu actions ────────────────────────────────────────────────
  // The MENUS themselves are custom popups drawn in the webview, anchored at
  // the button (see media/chat.js) -- not vscode.window.showQuickPick, which
  // would show as a top-of-window overlay unrelated to where the user
  // clicked. Native pickers are still used one level down, for the parts
  // that are genuinely OS/workspace file browsing (showOpenDialog, and a
  // QuickPick specifically for fuzzy workspace-file search), since those are
  // a different, expected kind of native UI, not the "what do you want to
  // do" menu itself.

  private async uploadFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Attach' });
    const uri = uris?.[0];
    if (!uri) {
      return;
    }
    if (IMAGE_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase())) {
      this.post({ type: 'attachmentAdded', path: uri.fsPath, name: path.basename(uri.fsPath), kind: 'image' });
      return;
    }
    // Any other file type: read it now as text context. Unlike a workspace
    // mention, this file may be OUTSIDE the workspace (picked via a native
    // file dialog), so the model can't necessarily reach it through its own
    // sandboxed filesystem tools -- attach the content directly instead.
    try {
      const content = await fs.promises.readFile(uri.fsPath, 'utf8');
      this.post({ type: 'attachmentAdded', path: uri.fsPath, name: path.basename(uri.fsPath), kind: 'text', content });
    } catch {
      void vscode.window.showErrorMessage(`ByteAsk: could not read '${path.basename(uri.fsPath)}' as text.`);
    }
  }

  /** Fuzzy-filterable QuickPick over workspace files; inserts an @relpath
   * token the model resolves itself via its own filesystem tools -- no need
   * to read/embed the file's content client-side for anything IN the
   * workspace. */
  private async mentionFile(): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**}', 500);
    const items = files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri, false) }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Mention file from this project...' });
    if (!pick) {
      return;
    }
    this.post({ type: 'insertText', text: `@${pick.label}` });
  }

  private async switchModel(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const res = await client.modelList({});
      const items = res.data
        .filter((m) => !m.hidden)
        .map((m) => ({ label: m.displayName, description: m.description, model: m.model }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Switch model...' });
      if (!pick) {
        return;
      }
      this.pinnedModel = pick.model;
      this.post({ type: 'systemMessage', text: `Model set to ${pick.label} for new messages.` });
    } catch (err) {
      this.reportUnreachable(err, 'Could not list models');
    }
  }

  /** Real `/status`: current session configuration, no fabricated fields. */
  private showStatus(): void {
    const lines = [
      `Thread: ${this.threadId ?? '(none yet -- starts on your next message)'}`,
      `Model: ${this.pinnedModel ?? '(byteask default)'}`,
      `Workspace: ${this.workspaceCwd()}`,
    ];
    this.post({ type: 'systemMessage', text: lines.join('\n') });
  }

  /**
   * Real `/usage`: `account/usage/read` + `account/rateLimits/read`.
   *
   * These two RPCs only work for a "Sign in with ChatGPT" (OpenAI/codex)
   * account -- confirmed by reading the engine source
   * (app-server/src/request_processors/account_processor.rs): they load
   * `AuthManager::auth()` from `auth.json`, which a ByteAsk account (signed
   * in via the gateway's own magic-link flow) never has. That's a genuinely
   * different, separate auth system from the one used for model traffic and
   * for `byteask`'s own `/usage`, which for a ByteAsk account bypasses
   * app-server entirely and calls the gateway directly with a bearer token
   * that isn't exposed through any app-server RPC (checked `config/read`'s
   * generated response type -- it isn't there, deliberately, since it's a
   * credential). So there is no supported way for this extension to fetch
   * that number itself; the honest move is to say so and hand off to the
   * one place it *does* work.
   */
  private async showUsage(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const [usage, limits] = await Promise.allSettled([client.getAccountUsage(), client.getAccountRateLimits()]);
      const authError = /codex account authentication required/i;
      const usageFailedOnAuth = usage.status === 'rejected' && authError.test(String(usage.reason));
      const limitsFailedOnAuth = limits.status === 'rejected' && authError.test(String(limits.reason));

      if (usageFailedOnAuth && limitsFailedOnAuth) {
        this.post({
          type: 'systemMessage',
          text:
            "Usage/quota isn't readable from here: byteask exposes it via a ChatGPT-account-only API, " +
            "which a ByteAsk (magic-link) sign-in doesn't have. byteask's own /usage works because it " +
            "talks to the ByteAsk gateway directly with a credential this extension can't access.",
        });
        const choice = await vscode.window.showInformationMessage(
          'ByteAsk: open the interactive terminal to run /usage there instead?',
          'Open Terminal'
        );
        if (choice === 'Open Terminal') {
          this.openAuthTerminal('');
        }
        return;
      }

      const lines: string[] = [];
      if (usage.status === 'fulfilled') {
        const s = usage.value.summary;
        if (s.lifetimeTokens != null) {
          lines.push(`Lifetime tokens: ${Number(s.lifetimeTokens).toLocaleString()}`);
        }
        if (s.currentStreakDays != null) {
          lines.push(`Current streak: ${Number(s.currentStreakDays)} day(s)`);
        }
      } else {
        lines.push(`Usage: ${usage.reason instanceof Error ? usage.reason.message : String(usage.reason)}`);
      }
      if (limits.status === 'fulfilled') {
        const primary = limits.value.rateLimits.primary;
        if (primary) {
          lines.push(`Rate limit used: ${primary.usedPercent}%`);
        }
      } else {
        lines.push(`Rate limits: ${limits.reason instanceof Error ? limits.reason.message : String(limits.reason)}`);
      }
      this.post({ type: 'systemMessage', text: lines.join('\n') || 'No usage data available.' });
    } catch (err) {
      this.reportUnreachable(err, 'Could not read usage');
    }
  }

  /** Real `/diff`: `git diff` in the workspace, opened as a native diff-highlighted
   * document -- there is no per-turn "get current diff" pull request in the
   * protocol (only the push notification and per-item diffs used on
   * approval cards), so this genuinely shells out to git like the TUI does. */
  private async showDiff(): Promise<void> {
    const cwd = this.workspaceCwd();
    execFile('git', ['diff', '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 }, async (err, stdout) => {
      if (err && !stdout) {
        void vscode.window.showErrorMessage(`ByteAsk: git diff failed: ${err.message}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument({
        content: stdout.trim() || '(no changes)',
        language: 'diff',
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    });
  }

  /** Real `/skills`: lists this workspace's configured skills; picking one
   * inserts its default prompt (when it has one) so the user can fire it. */
  private async showSkills(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const res = await client.skillsList({ cwds: [this.workspaceCwd()] });
      const skills = res.data.flatMap((e) => e.skills).filter((s) => s.enabled);
      if (skills.length === 0) {
        this.post({ type: 'systemMessage', text: 'No skills found for this workspace.' });
        return;
      }
      const items = skills.map((s) => ({
        label: s.interface?.displayName || s.name,
        description: s.interface?.shortDescription || s.shortDescription || s.description,
        skill: s,
      }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Skills available in this workspace' });
      if (!pick) {
        return;
      }
      this.post({ type: 'insertText', text: pick.skill.interface?.defaultPrompt ?? `Use the ${pick.skill.name} skill.` });
    } catch (err) {
      this.reportUnreachable(err, 'Could not list skills');
    }
  }

  /** Real `/logout` (and login): these are real account RPCs
   * (`account/login/start`, `account/logout`) but a proper login flow needs
   * browser-redirect handling this extension doesn't implement yet -- the
   * honest, already-working path is the same terminal the rest of this
   * extension already uses for the CLI. Also reused (with an empty action)
   * to hand off to the interactive TUI for things this extension genuinely
   * can't do itself, like `/usage` on a ByteAsk-gateway account. */
  private openAuthTerminal(action: 'login' | 'logout' | ''): void {
    const command = vscode.workspace.getConfiguration('byteask').get<string>('command', 'byteask');
    const term = vscode.window.createTerminal({ name: 'ByteAsk', cwd: this.workspaceCwd() });
    term.show();
    term.sendText(action ? `${command} ${action}` : command);
  }

  /**
   * One-click install for the "ByteAsk CLI not found" onboarding card. Runs
   * in a visible integrated terminal (not silently in the background) so
   * the user can watch it, approve/deny prompts it shows, and Ctrl+C it --
   * same trust model as any curl-pipe-to-shell installer, and this is
   * literally the same script https://code.byteask.ai/install.sh runs, which
   * is also what the CLI's own npm package (@byteask/cli) falls back to on
   * an unrecognized platform. Chosen over `npm install -g @byteask/cli` or
   * `pip install byteask` as the DEFAULT action (both remain available as
   * copyable manual options in the card) because this extension's own
   * audience is C/C++ developers, who are far less likely to already have
   * Node or Python toolchains installed than a JS/Python dev would -- the
   * platform's native shell is the only dependency guaranteed to exist.
   */
  private installCli(): void {
    const term = vscode.window.createTerminal({ name: 'Install ByteAsk' });
    term.show();
    if (process.platform === 'win32') {
      term.sendText('powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm https://code.byteask.ai/install.ps1)"');
    } else {
      term.sendText('curl -fsSL https://code.byteask.ai/install.sh | sh');
    }
  }

  /** "I already installed it" button on the onboarding card: drop the
   * cached (nonexistent) client and try again, exactly like the very first
   * connection attempt would. */
  private async retryConnect(): Promise<void> {
    this.client = undefined;
    try {
      await this.ensureClient();
      this.post({ type: 'connected' });
      await this.autoResumeLatest();
    } catch (err) {
      this.reportUnreachable(err, 'Still could not reach byteask');
    }
  }

  /**
   * Abandon the current thread and let the next message start a fresh one.
   * Interrupts an in-progress turn and auto-declines any approval or
   * pending question the server is still waiting on, so it isn't left
   * blocked forever once the webview has moved on.
   */
  private async startNewThread(): Promise<void> {
    if (this.client && this.threadId && this.currentTurnId && this.turnInProgress) {
      try {
        await this.client.turnInterrupt({ threadId: this.threadId, turnId: this.currentTurnId });
      } catch {
        /* best-effort */
      }
    }
    for (const { resolve } of this.pendingApprovals.values()) {
      resolve('decline');
    }
    this.pendingApprovals.clear();
    this.approvalDiffText.clear();
    for (const { resolve } of this.pendingUserInputs.values()) {
      resolve({ answers: {} });
    }
    this.pendingUserInputs.clear();
    this.cachedItems.clear();
    this.threadId = undefined;
    this.currentTurnId = undefined;
    this.turnInProgress = false;
    this.post({ type: 'cleared' });
  }

  /**
   * Fetch past sessions for the history picker -- GLOBAL, across every repo,
   * not scoped to this workspace's cwd. This mirrors how Claude Code's own
   * history browser works (it shows sessions from unrelated projects too);
   * scoping this to `cwd` would make it look like a narrower, extension-owned
   * history when it's actually a window into the same shared ~/.byteask
   * store everything else reads from. `sourceKinds` is passed explicitly
   * because the server's default for an omitted filter is "interactive
   * sources only", which would silently hide e.g. `exec`-sourced sessions.
   */
  private async listSessions(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const res = await client.threadList({
        sortKey: 'updated_at',
        sortDirection: 'desc',
        limit: 100,
        archived: false,
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
      });
      const sessions = res.data.map((t) => ({
        id: t.id,
        title: t.name || t.preview || '(no message yet)',
        updatedAt: t.updatedAt,
        cwd: t.cwd,
      }));
      this.post({ type: 'sessionList', sessions });
    } catch (err) {
      this.reportUnreachable(err, 'Failed to list sessions');
    }
  }

  /** On first opening the view, silently continue THIS workspace's most
   * recent session if one exists (scoped to cwd, unlike the global history
   * list above -- auto-continuing into an unrelated repo's conversation
   * would be confusing). No local bookkeeping: this is a live query every
   * time the view is created. */
  private async autoResumeLatest(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const res = await client.threadList({
        cwd: this.workspaceCwd(),
        sortKey: 'updated_at',
        sortDirection: 'desc',
        limit: 1,
        archived: false,
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'],
      });
      const latest = res.data[0];
      if (latest) {
        await this.resumeThreadById(latest.id);
      }
    } catch (err) {
      // Silent for everything EXCEPT "the CLI isn't installed" / "nobody's
      // logged in" -- a resume failure at startup for other reasons (no
      // history yet, a transient hiccup) shouldn't greet a user who hasn't
      // done anything yet with an error card, but these two ARE exactly the
      // moment a first-time (or logged-out) user needs to see the
      // corresponding onboarding card, not a quietly-logged line they'd
      // never notice until they typed a message and got confused.
      if (AppServerClient.isCliNotFoundError(err)) {
        this.post({ type: 'cliNotFound' });
      } else if (AppServerClient.isNotLoggedInError(err)) {
        this.post({ type: 'notLoggedIn' });
      } else {
        this.output.appendLine(`[chat] auto-resume skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Resume a specific thread (picked from history, or auto-resumed) and
   * replay its transcript from the turns/items the resume response already
   * includes by default -- no separate read call needed. */
  private async resumeThreadById(threadId: string): Promise<void> {
    if (!threadId) {
      return;
    }
    await this.startNewThread(); // abandon whatever's active first, same as "New chat"
    try {
      const client = await this.ensureClient();
      const res: ThreadResumeResponse = await client.threadResume({ threadId, approvalPolicy: 'on-request' });
      this.threadId = res.thread.id;
      this.replayTranscript(res.thread.turns);
    } catch (err) {
      this.reportUnreachable(err, 'Failed to resume session');
    }
  }

  private replayTranscript(turns: ThreadResumeResponse['thread']['turns']): void {
    for (const turn of turns) {
      for (const item of turn.items) {
        this.cachedItems.set(item.id, item);
        if (item.type === 'userMessage') {
          const text = item.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .filter((t) => t !== '')
            .join('\n');
          this.post({ type: 'userMessage', text });
        } else {
          this.post({ type: 'itemCompleted', item });
        }
      }
    }
  }

  private async sendMessage(text: string, attachment?: Attachment | null): Promise<void> {
    if (text.trim() === '' && !attachment) {
      return;
    }
    this.post({ type: 'userMessage', text: attachment ? `${text}\n📎 ${attachment.name}` : text });
    try {
      const client = await this.ensureClient();
      if (!this.threadId) {
        // approvalPolicy explicitly 'on-request': without it, byteask falls
        // back to its own default (which turned out to apply edits without
        // asking at all) rather than the "ask before edits" behavior this
        // whole approval-card UI exists for.
        this.output.appendLine(`[chat] thread/start cwd=${this.workspaceCwd()} approvalPolicy=on-request`);
        const res = await client.threadStart({
          cwd: this.workspaceCwd(),
          model: this.pinnedModel,
          approvalPolicy: 'on-request',
        });
        this.threadId = res.thread.id;
        this.output.appendLine(`[chat] thread/start -> threadId=${this.threadId} responseApprovalPolicy=${res.approvalPolicy}`);
      }
      const input: UserInput[] = [{ type: 'text', text, text_elements: [] }];
      if (attachment?.kind === 'image') {
        input.push({ type: 'localImage', path: attachment.path });
      } else if (attachment?.kind === 'text' && attachment.content) {
        input[0] = {
          type: 'text',
          text: `${text}\n\nAttached file (${attachment.name}):\n\`\`\`\n${attachment.content}\n\`\`\``,
          text_elements: [],
        };
      }
      // Re-assert on every turn, not just at thread creation/resume time --
      // a thread resumed from before this policy existed (or started by
      // something else entirely, e.g. the CLI) shouldn't silently keep
      // whatever policy it had; every turn from this UI should ask.
      this.output.appendLine(`[chat] turn/start threadId=${this.threadId} approvalPolicy=on-request`);
      await client.turnStart({
        threadId: this.threadId,
        input,
        model: this.pinnedModel,
        approvalPolicy: 'on-request',
      });
    } catch (err) {
      this.reportUnreachable(err, 'Failed to reach byteask');
    }
  }

  dispose(): void {
    this.client?.dispose();
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
