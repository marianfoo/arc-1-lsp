/**
 * stderr-only structured logger. stdout is reserved for MCP JSON-RPC — never
 * use console.log here (it corrupts the protocol on stdio transport).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min: Level = (process.env.ARC1_LOG_LEVEL as Level) || 'info';

function emit(level: Level, msg: string): void {
  if (order[level] < order[min]) return;
  process.stderr.write(`[${level}] ${msg}\n`);
}

export const logger = {
  debug: (m: string) => emit('debug', m),
  info: (m: string) => emit('info', m),
  warn: (m: string) => emit('warn', m),
  error: (m: string) => emit('error', m),
};
