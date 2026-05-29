/**
 * Config parser. Precedence: CLI flag > env var > default. Pure function for
 * easy testing (mirrors ARC-1's config approach).
 */
export type Transport = 'stdio' | 'http-streamable';

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
  const httpPort = flag(argv, 'port') ?? env.ARC1_PORT;
  return {
    adtLsPath: flag(argv, 'adt-ls-path') ?? env.ARC1_ADT_LS_PATH,
    adtLsMcpPort: port ? Number(port) : 2240,
    adtLsMcpToken: flag(argv, 'adt-ls-mcp-token') ?? env.ARC1_ADT_LS_MCP_TOKEN,
    transport,
    httpPort: httpPort ? Number(httpPort) : 8080,
    apiKeys: flag(argv, 'api-keys') ?? env.ARC1_API_KEYS,
  };
}
