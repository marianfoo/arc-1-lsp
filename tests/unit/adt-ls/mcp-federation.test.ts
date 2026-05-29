import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdtLsMcpClient } from '../../../src/adt-ls/mcp-federation.js';

function sse(obj: unknown, sessionId?: string, status = 200) {
  return {
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'mcp-session-id' ? (sessionId ?? null) : null) },
    text: async () => `event: message\ndata: ${JSON.stringify(obj)}\n\n`,
  };
}

describe('AdtLsMcpClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connect performs the initialize handshake, captures + reuses the session id, and sends the bearer', async () => {
    fetchMock
      .mockResolvedValueOnce(sse({ jsonrpc: '2.0', id: 1, result: {} }, 'sess-1'))
      .mockResolvedValueOnce(sse({}, undefined, 202));
    const c = new AdtLsMcpClient('http://localhost:2240/mcp', 'tok');
    await c.connect();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:2240/mcp');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(opts.body).method).toBe('initialize');
    // second request carries the captured session id
    expect(fetchMock.mock.calls[1][1].headers['Mcp-Session-Id']).toBe('sess-1');
  });

  it('throws if initialize does not return a session id', async () => {
    fetchMock.mockResolvedValueOnce(sse({ result: {} }, undefined, 401));
    const c = new AdtLsMcpClient('http://localhost:2240/mcp', 'bad');
    await expect(c.connect()).rejects.toThrow(/initialize failed: HTTP 401/);
  });

  it('listTools parses the SSE tool list', async () => {
    fetchMock
      .mockResolvedValueOnce(sse({ result: {} }, 'sess-1'))
      .mockResolvedValueOnce(sse({}, undefined, 202))
      .mockResolvedValueOnce(
        sse({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'abap_list_destinations' }] } }, 'sess-1'),
      );
    const c = new AdtLsMcpClient('http://localhost:2240/mcp', 'tok');
    await c.connect();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['abap_list_destinations']);
  });

  it('callTool throws on an error result', async () => {
    fetchMock
      .mockResolvedValueOnce(sse({ result: {} }, 'sess-1'))
      .mockResolvedValueOnce(sse({}, undefined, 202))
      .mockResolvedValueOnce(sse({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'boom' } }, 'sess-1'));
    const c = new AdtLsMcpClient('http://localhost:2240/mcp', 'tok');
    await c.connect();
    await expect(c.callTool('abap_list_destinations')).rejects.toThrow(/boom/);
  });
});
