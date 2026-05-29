/**
 * Config parser. Precedence: CLI flag > env var > default. Pure function for
 * easy testing (mirrors ARC-1's config approach).
 */
export type Transport = 'stdio' | 'http-streamable';

/**
 * A SAP backend to auto-connect on startup (fixed-user / Phase A). When set, the
 * engine builds TLS material, starts the reverse proxy, and logs on headlessly
 * (ADR-0006). Omitted ⇒ foundation mode (health/list_destinations only).
 */
export interface SapTargetConfig {
  /** adt-ls destination id (what tool callers pass as `destination`). */
  destinationId: string;
  /** Real backend host the reverse proxy forwards to. */
  host: string;
  /** Real backend HTTPS port. */
  port: number;
  user: string;
  password: string;
  client: string;
  language: string;
  /** Accept the backend's (self-signed) cert. Default true — backend TLS is ours. */
  insecure: boolean;
}

export interface Arc1LspConfig {
  /** Explicit adt-ls binary path; otherwise discovered. */
  adtLsPath?: string;
  /** Port adt-ls's own MCP server listens on (distinct from VS Code's 2236). */
  adtLsMcpPort: number;
  /** Bearer token for adt-ls's MCP server; generated if omitted. */
  adtLsMcpToken?: string;
  /** Transport for arc-1-lsp's own MCP server. */
  transport: Transport;
  /** HTTP port when transport is http-streamable. */
  httpPort: number;
  /** API keys for the HTTP edge (comma-separated `key` or `key:label`); empty = auth disabled. */
  apiKeys?: string;
  /** Optional SAP backend to auto-connect on startup (local/direct). */
  sapTarget?: SapTargetConfig;
  /**
   * BTP Destination Service name to resolve + connect on startup (CF path). When
   * running on BTP with a connectivity binding, this destination supplies the
   * virtual host, basic creds, and Cloud-Connector location. Takes precedence
   * over `sapTarget` on BTP.
   */
  sapDestination?: string;
  /** Enable mutating tools (create/update/activate/delete). Default false. */
  allowWrites: boolean;
  /** Packages writes may target (exact / `PREFIX*` / `*`). Default `['$TMP']`. */
  allowedPackages: string[];
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return v === 'true' || v === '1' || v === 'yes';
}

/** Build the SAP target from flags/env, or undefined if host/port/creds missing. */
function loadSapTarget(argv: string[], env: NodeJS.ProcessEnv): SapTargetConfig | undefined {
  const host = flag(argv, 'sap-host') ?? env.ARC1_SAP_HOST;
  const port = flag(argv, 'sap-port') ?? env.ARC1_SAP_PORT;
  const user = flag(argv, 'sap-user') ?? env.ARC1_SAP_USER;
  const password = flag(argv, 'sap-password') ?? env.ARC1_SAP_PASSWORD;
  if (!host || !port || !user || !password) return undefined;
  return {
    destinationId: flag(argv, 'sap-destination') ?? env.ARC1_SAP_DESTINATION ?? 'SAP',
    host,
    port: Number(port),
    user,
    password,
    client: flag(argv, 'sap-client') ?? env.ARC1_SAP_CLIENT ?? '001',
    language: flag(argv, 'sap-language') ?? env.ARC1_SAP_LANGUAGE ?? 'EN',
    insecure: bool(flag(argv, 'sap-insecure') ?? env.ARC1_SAP_INSECURE, true),
  };
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Arc1LspConfig {
  const transport = (flag(argv, 'transport') ?? env.ARC1_TRANSPORT ?? 'stdio') as Transport;
  if (transport !== 'stdio' && transport !== 'http-streamable') {
    throw new Error(`Invalid transport "${transport}" (expected stdio | http-streamable)`);
  }
  const port = flag(argv, 'adt-ls-mcp-port') ?? env.ARC1_ADT_LS_MCP_PORT;
  // CF assigns $PORT at runtime — honor it (after explicit flag/ARC1_PORT).
  const httpPort = flag(argv, 'port') ?? env.ARC1_PORT ?? env.PORT;
  return {
    adtLsPath: flag(argv, 'adt-ls-path') ?? env.ARC1_ADT_LS_PATH,
    adtLsMcpPort: port ? Number(port) : 2240,
    adtLsMcpToken: flag(argv, 'adt-ls-mcp-token') ?? env.ARC1_ADT_LS_MCP_TOKEN,
    transport,
    httpPort: httpPort ? Number(httpPort) : 8080,
    apiKeys: flag(argv, 'api-keys') ?? env.ARC1_API_KEYS,
    sapTarget: loadSapTarget(argv, env),
    sapDestination: flag(argv, 'sap-destination') ?? env.ARC1_SAP_DESTINATION,
    allowWrites: bool(flag(argv, 'allow-writes') ?? env.ARC1_ALLOW_WRITES, false),
    allowedPackages: (flag(argv, 'allowed-packages') ?? env.ARC1_ALLOWED_PACKAGES ?? '$TMP')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  };
}
