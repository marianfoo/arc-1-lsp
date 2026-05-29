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

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error(`adt-ls start timed out after ${ms}ms`)), ms);
    t.unref();
  });
}

export class AdtLsDriver {
  private child?: ChildProcess;
  private server?: net.Server;
  private conn?: MessageConnection;
  private readonly dataDir: string;
  private readonly pipePath: string;
  initializeResult?: AdtLsInitializeResult;

  constructor(
    private readonly binPath: string,
    opts: { dataDir?: string } = {},
  ) {
    const id = crypto.randomBytes(6).toString('hex');
    this.dataDir = opts.dataDir ?? path.join(os.tmpdir(), `arc1lsp-${id}`);
    this.pipePath =
      process.platform === 'win32'
        ? path.join('\\\\.\\pipe\\', `arc1lsp-${id}`)
        : path.join(os.tmpdir(), `arc1lsp-${id}.sock`);
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
    // Acknowledge any server->client request so it never blocks the handshake.
    this.conn.onRequest((_method: string) => null);
    this.conn.listen();

    const result = (await this.conn.sendRequest('initialize', {
      processId: process.pid,
      clientInfo: { name: 'arc-1-lsp', version: '0.0.1' },
      rootUri: null,
      workspaceFolders: null,
      capabilities: {},
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
