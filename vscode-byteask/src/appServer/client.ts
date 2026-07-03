// Typed convenience wrapper over rpc.ts, using the real generated bindings
// (src/appServer/generated/, produced by `byteask app-server generate-ts
// --experimental` — type-only, zero runtime cost, do not hand-edit).

import { AppServerRpc } from './rpc';
import type { InitializeParams } from './generated/InitializeParams';
import type { InitializeResponse } from './generated/InitializeResponse';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse';
import type { ThreadListParams } from './generated/v2/ThreadListParams';
import type { ThreadListResponse } from './generated/v2/ThreadListResponse';
import type { ModelListParams } from './generated/v2/ModelListParams';
import type { ModelListResponse } from './generated/v2/ModelListResponse';
import type { TurnStartParams } from './generated/v2/TurnStartParams';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse';
import type { TurnInterruptParams } from './generated/v2/TurnInterruptParams';
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification';
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification';
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification';
import type { ReasoningTextDeltaNotification } from './generated/v2/ReasoningTextDeltaNotification';
import type { TurnDiffUpdatedNotification } from './generated/v2/TurnDiffUpdatedNotification';
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification';
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification';
import type { ErrorNotification } from './generated/v2/ErrorNotification';
import type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams';
import type { FileChangeApprovalDecision } from './generated/v2/FileChangeApprovalDecision';
import type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams';
import type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision';
import type { GetAccountTokenUsageResponse } from './generated/v2/GetAccountTokenUsageResponse';
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse';
import type { SkillsListParams } from './generated/v2/SkillsListParams';
import type { SkillsListResponse } from './generated/v2/SkillsListResponse';
import type { ToolRequestUserInputParams } from './generated/v2/ToolRequestUserInputParams';
import type { ToolRequestUserInputResponse } from './generated/v2/ToolRequestUserInputResponse';

export interface AppServerCallbacks {
  onItemStarted(n: ItemStartedNotification): void;
  onItemCompleted(n: ItemCompletedNotification): void;
  onAgentMessageDelta(n: AgentMessageDeltaNotification): void;
  onReasoningTextDelta(n: ReasoningTextDeltaNotification): void;
  onTurnDiffUpdated(n: TurnDiffUpdatedNotification): void;
  onTurnStarted(n: TurnStartedNotification): void;
  onTurnCompleted(n: TurnCompletedNotification): void;
  onError(n: ErrorNotification): void;
  /** Resolve with the user's decision once they act on the approval card. */
  onFileChangeApprovalRequest(p: FileChangeRequestApprovalParams): Promise<FileChangeApprovalDecision>;
  onCommandExecutionApprovalRequest(p: CommandExecutionRequestApprovalParams): Promise<CommandExecutionApprovalDecision>;
  /** The multi-choice "ask the user a question" tool (Claude Code's AskUserQuestion equivalent). */
  onToolRequestUserInput(p: ToolRequestUserInputParams): Promise<ToolRequestUserInputResponse>;
}

/** One `byteask app-server` connection: handshake done, ready for thread/turn calls. */
export class AppServerClient {
  private rpc: AppServerRpc;

  private constructor(rpc: AppServerRpc) {
    this.rpc = rpc;
  }

  static async connect(command: string, cwd: string, callbacks: AppServerCallbacks): Promise<AppServerClient> {
    const rpc = new AppServerRpc(command, ['app-server'], cwd);
    const client = new AppServerClient(rpc);
    client.wireCallbacks(callbacks);

    const initParams: InitializeParams = {
      clientInfo: { name: 'vscode-byteask', title: 'ByteAsk', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    };
    await rpc.request<InitializeResponse>('initialize', initParams);
    return client;
  }

  private wireCallbacks(cb: AppServerCallbacks): void {
    this.rpc.onNotification('item/started', (p) => cb.onItemStarted(p as ItemStartedNotification));
    this.rpc.onNotification('item/completed', (p) => cb.onItemCompleted(p as ItemCompletedNotification));
    this.rpc.onNotification('item/agentMessage/delta', (p) => cb.onAgentMessageDelta(p as AgentMessageDeltaNotification));
    this.rpc.onNotification('item/reasoning/textDelta', (p) => cb.onReasoningTextDelta(p as ReasoningTextDeltaNotification));
    this.rpc.onNotification('turn/diff/updated', (p) => cb.onTurnDiffUpdated(p as TurnDiffUpdatedNotification));
    this.rpc.onNotification('turn/started', (p) => cb.onTurnStarted(p as TurnStartedNotification));
    this.rpc.onNotification('turn/completed', (p) => cb.onTurnCompleted(p as TurnCompletedNotification));
    this.rpc.onNotification('error', (p) => cb.onError(p as ErrorNotification));

    this.rpc.onServerRequest('item/fileChange/requestApproval', async (p) => {
      const decision = await cb.onFileChangeApprovalRequest(p as FileChangeRequestApprovalParams);
      return { decision };
    });
    this.rpc.onServerRequest('item/commandExecution/requestApproval', async (p) => {
      const decision = await cb.onCommandExecutionApprovalRequest(p as CommandExecutionRequestApprovalParams);
      return { decision };
    });
    this.rpc.onServerRequest('item/tool/requestUserInput', async (p) => {
      return cb.onToolRequestUserInput(p as ToolRequestUserInputParams);
    });
  }

  threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.rpc.request('thread/start', params);
  }

  threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.rpc.request('thread/resume', params);
  }

  threadList(params: ThreadListParams): Promise<ThreadListResponse> {
    return this.rpc.request('thread/list', params);
  }

  modelList(params: ModelListParams): Promise<ModelListResponse> {
    return this.rpc.request('model/list', params);
  }

  turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.rpc.request('turn/start', params);
  }

  turnInterrupt(params: TurnInterruptParams): Promise<Record<string, never>> {
    return this.rpc.request('turn/interrupt', params);
  }

  getAccountUsage(): Promise<GetAccountTokenUsageResponse> {
    return this.rpc.request('account/usage/read', undefined);
  }

  getAccountRateLimits(): Promise<GetAccountRateLimitsResponse> {
    return this.rpc.request('account/rateLimits/read', undefined);
  }

  skillsList(params: SkillsListParams): Promise<SkillsListResponse> {
    return this.rpc.request('skills/list', params);
  }

  setStderrHandler(handler: (line: string) => void): void {
    this.rpc.setStderrHandler(handler);
  }

  dispose(): void {
    this.rpc.dispose();
  }
}
