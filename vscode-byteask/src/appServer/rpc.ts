// Low-level JSON-RPC-over-stdio channel to `byteask app-server`.
//
// Wire format (confirmed against the real binary, not just the Rust type
// names): newline-delimited JSON, both directions.
//   - Client request:        {"method": string, "id": number|string, "params": T}
//   - Server response (ok):  {"id": number|string, "result": T}
//   - Server response (err): {"id": number|string, "error": {code, message}}
//   - Notification:          {"method": string, "params": T}   (no id)
//   - Server->client request: {"method": string, "id": number|string, "params": T}
//     (same shape as a client request; we must reply with {id, result|error})

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as readline from 'readline';

export type RequestId = number | string;

interface OutgoingEnvelope {
  method?: string;
  id?: RequestId;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface IncomingEnvelope {
  method?: string;
  id?: RequestId;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

type NotificationHandler = (params: unknown) => void;
type ServerRequestHandler = (params: unknown) => Promise<unknown>;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string
  ) {
    super(message);
  }
}

/** A single spawned `byteask app-server` process and its JSON-RPC channel. */
export class AppServerRpc {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private notificationHandlers = new Map<string, NotificationHandler[]>();
  private serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private onErrorLine?: (line: string) => void;
  private disposed = false;
  /**
   * Set the moment the child process itself fails to even start (most
   * commonly ENOENT -- the `byteask` binary isn't installed / not on PATH).
   * Node's `ChildProcess` is an EventEmitter, and an 'error' event with no
   * listener is a Node built-in special case that gets RE-THROWN as an
   * uncaught exception instead of silently dropped -- verified live: this
   * previously crashed the extension host outright the first time anyone
   * opened the chat view without the CLI installed, rather than showing any
   * error UI at all. Both a same-tick check (spawnError already set when
   * request() runs) and this event handler (fires after request() already
   * registered a pending promise) are needed since the ordering between
   * "spawn's async error event" and "the caller's first request() call" is
   * not guaranteed.
   */
  private spawnError?: Error;
  /**
   * Every stderr line, always recorded -- not just forwarded to whatever
   * `setStderrHandler` callback is attached. That callback is only wired up
   * by `AppServerClient.connect()` AFTER construction, but a process that
   * fails a startup precondition (e.g. `byteask app-server` refuses to even
   * start and exits immediately when nobody's logged in, printing "You're
   * not signed in to ByteAsk. Run: byteask login ...") can emit its one and
   * only useful stderr line and exit within milliseconds -- before any
   * external handler exists to catch it. Buffering here means the 'exit'
   * handler below can still surface that real message instead of a generic
   * "byteask app-server exited".
   */
  private stderrBuffer: string[] = [];

  constructor(command: string, args: string[], cwd: string) {
    this.proc = spawn(command, args, { cwd });

    this.proc.on('error', (err) => {
      this.spawnError = err;
      this.disposed = true;
      for (const { reject } of this.pending.values()) {
        reject(err);
      }
      this.pending.clear();
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') {
          this.stderrBuffer.push(line);
          this.onErrorLine?.(line);
        }
      }
    });

    this.proc.on('exit', (code) => {
      this.disposed = true;
      const detail = this.stderrBuffer.slice(-5).join(' ');
      const message = detail
        ? `byteask app-server exited (code ${code}): ${detail}`
        : `byteask app-server exited (code ${code})`;
      for (const { reject } of this.pending.values()) {
        reject(new Error(message));
      }
      this.pending.clear();
    });
  }

  setStderrHandler(handler: (line: string) => void): void {
    this.onErrorLine = handler;
  }

  private handleLine(line: string): void {
    if (line.trim() === '') {
      return;
    }
    let msg: IncomingEnvelope;
    try {
      msg = JSON.parse(line) as IncomingEnvelope;
    } catch {
      return; // not JSON — ignore (shouldn't happen on stdout)
    }

    // Response to one of our own requests: has an id we're tracking, and
    // either "result" or "error", but no "method" (a server->client request
    // also carries method+id, so the pending-map check disambiguates it).
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new RpcError(msg.error.code, msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification: method, no id.
    if (msg.method !== undefined && msg.id === undefined) {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) {
          h(msg.params);
        }
      }
      return;
    }

    // Server->client request: method + id, needs a reply.
    if (msg.method !== undefined && msg.id !== undefined) {
      const handler = this.serverRequestHandlers.get(msg.method);
      if (!handler) {
        this.writeRaw({ id: msg.id, error: { code: -32601, message: `No handler for ${msg.method}` } });
        return;
      }
      handler(msg.params)
        .then((result) => this.writeRaw({ id: msg.id, result }))
        .catch((err) =>
          this.writeRaw({ id: msg.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } })
        );
      return;
    }
  }

  private writeRaw(envelope: OutgoingEnvelope): void {
    if (this.disposed) {
      return;
    }
    this.proc.stdin.write(JSON.stringify(envelope) + '\n');
  }

  /** Send a client->server request and await its response. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.disposed) {
      const detail = this.stderrBuffer.slice(-5).join(' ');
      return Promise.reject(
        this.spawnError ?? new Error(detail ? `byteask app-server is not running: ${detail}` : 'byteask app-server is not running')
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.writeRaw({ method, id, params });
    });
  }

  /** Subscribe to a server->client notification method. */
  onNotification(method: string, handler: NotificationHandler): void {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
  }

  /**
   * Register the responder for a server->client request method. The handler
   * must resolve with the response payload (or throw/reject to send an
   * error back).
   */
  onServerRequest(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.proc.kill();
  }
}
