import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Engine } from '../../../src/server/engine.js';
import { createMcpServer } from '../../../src/server/server.js';

function fakeEngine(overrides: Partial<Engine> = {}): Engine {
  return {
    health: () => ({ adtLs: { name: 'ADTLS', version: '1.0.0', up: true }, mcpPort: 2240 }),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: 'text', text: '["A4H_001"]' }] }),
    setDestination: async () => {},
    search: async () => [],
    listInactiveObjects: async () => [],
    dispose: async () => {},
    ...overrides,
  };
}

async function linkedClient(engine: Engine): Promise<Client> {
  const server = createMcpServer(engine);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('createMcpServer', () => {
  it('registers exactly the foundation tools', async () => {
    const client = await linkedClient(fakeEngine());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'health',
      'list_creatable_objects',
      'list_destinations',
      'list_inactive_objects',
      'search_objects',
    ]);
  });

  it('health returns the engine health (adt-ls version + port)', async () => {
    const client = await linkedClient(fakeEngine());
    const res = await client.callTool({ name: 'health', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('ADTLS');
    expect(JSON.stringify(res.content)).toContain('2240');
  });

  it('list_destinations federates to the adt-ls abap_list_destinations tool', async () => {
    let calledWith: string | undefined;
    const client = await linkedClient(
      fakeEngine({
        callTool: async (name: string) => {
          calledWith = name;
          return { content: [{ type: 'text', text: '["A4H_001"]' }] };
        },
      }),
    );
    const res = await client.callTool({ name: 'list_destinations', arguments: {} });
    expect(calledWith).toBe('abap_list_destinations');
    expect(JSON.stringify(res.content)).toContain('A4H_001');
  });

  it('list_creatable_objects defaults to the startup-connected destination', async () => {
    let calledWith: { name?: string; args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (name: string, args?: Record<string, unknown>) => {
          calledWith = { name, args };
          return { content: [{ type: 'text', text: '{"creatableObjects":[]}' }] };
        },
      }),
    );
    await client.callTool({ name: 'list_creatable_objects', arguments: {} });
    expect(calledWith.name).toBe('abap_creation-get_all_creatable_objects');
    expect(calledWith.args).toEqual({ destination: 'A4H' });
  });

  it('list_creatable_objects errors clearly when no destination is connected', async () => {
    const client = await linkedClient(fakeEngine()); // no connectedDestination
    const res = await client.callTool({ name: 'list_creatable_objects', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('No ABAP destination is connected');
  });

  it('search_objects delegates to engine.search with the pattern + options', async () => {
    let got: { pattern?: string; opts?: unknown } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        search: async (pattern, opts) => {
          got = { pattern, opts };
          return [{ name: 'CL_ABAP_TYPEDESCR', type: 'Class', uri: '/sap/bc/adt/oo/classes/cl_abap_typedescr' }];
        },
      }),
    );
    const res = await client.callTool({
      name: 'search_objects',
      arguments: { pattern: 'CL_ABAP*', maxResults: 5 },
    });
    expect(got).toEqual({ pattern: 'CL_ABAP*', opts: { maxResults: 5, types: undefined } });
    expect(JSON.stringify(res.content)).toContain('CL_ABAP_TYPEDESCR');
  });

  it('search_objects + list_inactive_objects error clearly with no destination', async () => {
    const client = await linkedClient(fakeEngine());
    const s = await client.callTool({ name: 'search_objects', arguments: { pattern: 'X' } });
    expect(JSON.stringify(s.content)).toContain('No ABAP destination is connected');
    const i = await client.callTool({ name: 'list_inactive_objects', arguments: {} });
    expect(JSON.stringify(i.content)).toContain('No ABAP destination is connected');
  });

  it('list_inactive_objects returns the engine result when connected', async () => {
    const client = await linkedClient(
      fakeEngine({ connectedDestination: 'A4H', listInactiveObjects: async () => [{ name: 'ZCL_DRAFT' }] }),
    );
    const res = await client.callTool({ name: 'list_inactive_objects', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('ZCL_DRAFT');
  });
});
