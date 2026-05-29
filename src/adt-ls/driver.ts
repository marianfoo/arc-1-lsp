/**
 * AdtLsDriver — spawn `adt-ls` headless and speak LSP over a named pipe, exactly
 * as the sapse.adt-vscode extension does: args `-Djco.trace_path <dir> -data
 * <dir> --pipe=<pipe>`; the client listens on the pipe and adt-ls connects to
 * it. Uses vscode-jsonrpc for message framing.
 *
 * This is the engine: arc-1-lsp performs NO ADT HTTP/CSRF/locking/XML itself —
 * everything goes through adt-ls via this driver (LSP) or its MCP endpoint.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from 'vscode-jsonrpc/node.js';
import { logger } from '../server/logger.js';

export interface AdtLsInitializeResult {
  serverInfo?: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

/** Handler for a server→client LSP request (e.g. requestBrowserBasedLogon). */
export type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;

/**
 * The LSP request channel alone. Consumers that only send requests (repository
 * queries, the authoring lifecycle) depend on this minimal surface, so a
 * session-retry wrapper — or a test fake — can stand in for the full driver.
 */
export interface LspRequester {
  sendRequest<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/**
 * Route a server→client request to a registered handler, with safe defaults.
 * Pure (no I/O) so it can be unit-tested directly.
 * - registered handler wins (e.g. `adtLs/destinations/requestBrowserBasedLogon`)
 * - `workspace/configuration` MUST return an array of nulls, one per item
 *   ("use defaults") — a bare null errors adt-ls's destination init.
 * - everything else (client/registerCapability, window/workDoneProgress/create…)
 *   → null is accepted.
 */
export function routeServerRequest(
  method: string,
  params: unknown,
  handlers: Record<string, ServerRequestHandler>,
): unknown | Promise<unknown> {
  const handler = handlers[method];
  if (handler) return handler(params);
  if (method === 'workspace/configuration') {
    const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
    return items.map(() => null);
  }
  return null;
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`adt-ls start timed out after ${ms}ms`)), ms);
    t.unref();
  });
}

export class AdtLsDriver implements LspRequester {
  private child?: ChildProcess;
  private server?: net.Server;
  private conn?: MessageConnection;
  private readonly dataDir: string;
  private readonly pipePath: string;
  private readonly extraEnv: Record<string, string>;
  private readonly requestHandlers: Record<string, ServerRequestHandler>;
  initializeResult?: AdtLsInitializeResult;

  constructor(
    private readonly binPath: string,
    opts: {
      dataDir?: string;
      /** Extra env for the spawned JVM (e.g. JAVA_TOOL_OPTIONS truststore). */
      extraEnv?: Record<string, string>;
      /** server→client request handlers, keyed by LSP method. */
      requestHandlers?: Record<string, ServerRequestHandler>;
    } = {},
  ) {
    const id = crypto.randomBytes(6).toString('hex');
    this.dataDir = opts.dataDir ?? path.join(os.tmpdir(), `arc1lsp-${id}`);
    this.extraEnv = opts.extraEnv ?? {};
    this.requestHandlers = { ...opts.requestHandlers };
    this.pipePath =
      process.platform === 'win32'
        ? path.join('\\\\.\\pipe\\', `arc1lsp-${id}`)
        : path.join(os.tmpdir(), `arc1lsp-${id}.sock`);
  }

  /** Register/replace a server→client request handler (before or after start). */
  setRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.requestHandlers[method] = handler;
  }

  async start(timeoutMs = 60000): Promise<AdtLsInitializeResult> {
    await fsp.mkdir(this.dataDir, { recursive: true });
    if (process.platform !== 'win32') {
      await fsp.rm(this.pipePath, { force: true });
    }

    const connected = new Promise<net.Socket>((resolve, reject) => {
      this.server = net.createServer((socket) => resolve(socket));
      this.server.on('error', reject);
      this.server.listen(this.pipePath);
    });

    const tail: string[] = [];
    const capture = (d: Buffer) => {
      const s = d.toString();
      tail.push(s);
      if (tail.length > 60) tail.shift();
    };
    this.child = spawn(
      this.binPath,
      ['-Djco.trace_path', this.dataDir, '-data', this.dataDir, `--pipe=${this.pipePath}`],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...this.extraEnv },
      },
    );
    this.child.stdout?.on('data', capture);
    this.child.stderr?.on('data', (d: Buffer) => {
      capture(d);
      logger.debug(`[adt-ls] ${d.toString().trimEnd()}`);
    });
    const exited = new Promise<never>((_, reject) => {
      this.child?.on('exit', (code) =>
        reject(new Error(`adt-ls exited (code ${code}) before initialize. Last output:\n${tail.slice(-12).join('')}`)),
      );
    });

    const socket = (await Promise.race([connected, exited, timeoutReject(timeoutMs)])) as net.Socket;
    this.conn = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
    // Route every server->client request through the registered handlers (with
    // safe defaults) so the handshake + logon never block. See routeServerRequest.
    this.conn.onRequest((method: string, params: unknown) => routeServerRequest(method, params, this.requestHandlers));
    this.conn.listen();

    const result = (await this.conn.sendRequest('initialize', {
      processId: process.pid,
      clientInfo: { name: 'arc-1-lsp', version: '0.0.1' },
      rootUri: null,
      workspaceFolders: null,
      capabilities: {},
      // REQUIRED for any backend HTTP: adt-ls's UserAgentUtil builds the
      // User-Agent from initializationOptions.userAgentInfos; if absent, its
      // static initializer NPEs and every HTTP destination operation fails with
      // "Could not initialize class …HttpRequestHeaderUtil". (Verified 2026-05-29.)
      initializationOptions: { userAgentInfos: [{ name: 'arc-1-lsp', version: '0.0.1' }] },
    })) as AdtLsInitializeResult;
    this.conn.sendNotification('initialized', {});
    this.initializeResult = result;
    logger.info(`adt-ls ready: ${result.serverInfo?.name} ${result.serverInfo?.version}`);
    return result;
  }

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.conn) throw new Error('AdtLsDriver not started');
    return this.conn.sendRequest(method, params) as Promise<T>;
  }

  async dispose(): Promise<void> {
    try {
      this.conn?.dispose();
    } catch {
      // best-effort
    }
    try {
      this.child?.kill('SIGKILL');
    } catch {
      // best-effort
    }
    try {
      this.server?.close();
    } catch {
      // best-effort
    }
    if (process.platform !== 'win32') {
      await fsp.rm(this.pipePath, { force: true }).catch(() => {});
    }
    await fsp.rm(this.dataDir, { recursive: true, force: true }).catch(() => {});
  }
}
