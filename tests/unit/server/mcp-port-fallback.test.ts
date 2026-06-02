import { describe, expect, it, vi } from 'vitest';
import { startMcpWithPortFallback } from '../../../src/server/engine.js';

describe('startMcpWithPortFallback', () => {
  it('returns immediately when the first port binds', async () => {
    const start = vi.fn(async (port: number) => ({ port, token: 't' }));
    const r = await startMcpWithPortFallback(start, 2240);
    expect(r.port).toBe(2240);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next port on a bind failure, then succeeds', async () => {
    const tried: number[] = [];
    const start = vi.fn(async (port: number) => {
      tried.push(port);
      if (port < 2242) throw new Error(`Failed to start MCP server: Failed to bind to localhost/127.0.0.1:${port}`);
      return { port, token: 't' };
    });
    const onRetry = vi.fn();
    const r = await startMcpWithPortFallback(start, 2240, 20, onRetry);
    expect(r.port).toBe(2242);
    expect(tried).toEqual([2240, 2241, 2242]);
    expect(onRetry).toHaveBeenCalledTimes(2); // 2240 + 2241 busy
  });

  it('rethrows a non-bind error immediately (no retry)', async () => {
    const start = vi.fn(async () => {
      throw new Error('Your user was logged off');
    });
    await expect(startMcpWithPortFallback(start, 2240)).rejects.toThrow(/logged off/);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('gives up after `attempts` consecutive bind failures, surfacing the last error', async () => {
    const start = vi.fn(async (port: number) => {
      throw new Error(`Failed to bind to localhost/127.0.0.1:${port}`);
    });
    await expect(startMcpWithPortFallback(start, 2240, 3)).rejects.toThrow(/Failed to bind/);
    expect(start).toHaveBeenCalledTimes(3);
  });
});
