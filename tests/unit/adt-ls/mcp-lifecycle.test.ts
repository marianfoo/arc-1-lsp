import { describe, expect, it, vi } from 'vitest';
import type { AdtLsDriver } from '../../../src/adt-ls/driver.js';
import { setMcpDestination, startMcpServer, stopMcpServer } from '../../../src/adt-ls/mcp-lifecycle.js';

function fakeDriver(result: unknown = { port: 2240, token: 't' }) {
  const sendRequest = vi.fn().mockResolvedValue(result);
  return { driver: { sendRequest } as unknown as AdtLsDriver, sendRequest };
}

describe('mcp-lifecycle', () => {
  it('startMcpServer sends adtLs/mcp/startMCPServer with port+token and returns effective values', async () => {
    const { driver, sendRequest } = fakeDriver({ port: 2240, token: 'effective' });
    const r = await startMcpServer(driver, { port: 2240, token: 'tok' });
    expect(sendRequest).toHaveBeenCalledWith('adtLs/mcp/startMCPServer', { port: 2240, token: 'tok' });
    expect(r).toEqual({ port: 2240, token: 'effective' });
  });

  it('stopMcpServer sends adtLs/mcp/stopMCPServer', async () => {
    const { driver, sendRequest } = fakeDriver();
    await stopMcpServer(driver);
    expect(sendRequest).toHaveBeenCalledWith('adtLs/mcp/stopMCPServer');
  });

  it('setMcpDestination sends adtLs/mcp/setDestination with destinationId', async () => {
    const { driver, sendRequest } = fakeDriver();
    await setMcpDestination(driver, 'A4H_001_DEVELOPER_EN');
    expect(sendRequest).toHaveBeenCalledWith('adtLs/mcp/setDestination', { destinationId: 'A4H_001_DEVELOPER_EN' });
  });
});
