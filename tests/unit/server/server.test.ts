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
    listUsers: async () => [],
    lifecycle: {
      resolveAffUri: async () => 'abap:/repotree-v1/A4H/x.clas.abap',
      readSource: async () => 'CLASS zcl_x.',
      createObject: async () => ({ message: 'created', filePath: 'abap:/x.clas.abap' }),
      updateSource: async () => {},
      activate: async () => ({ success: true, diagnostics: [] }),
      runUnitTests: async () => ({ result: 'No tests found' }),
      deleteObject: async () => {},
    },
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
      'activate_object',
      'create_object',
      'delete_object',
      'get_generator_schema',
      'get_object_type_details',
      'get_service_binding',
      'health',
      'list_creatable_objects',
      'list_destinations',
      'list_generators',
      'list_inactive_objects',
      'list_users',
      'read_source',
      'run_unit_tests',
      'search_objects',
      'update_source',
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

  it('list_users returns engine.listUsers when connected', async () => {
    const client = await linkedClient(
      fakeEngine({ connectedDestination: 'A4H', listUsers: async () => [{ id: 'DEVELOPER', text: 'John Doe' }] }),
    );
    const res = await client.callTool({ name: 'list_users', arguments: {} });
    expect(JSON.stringify(res.content)).toContain('DEVELOPER');
  });

  it('list_generators delegates to the federated generators tool with the connected destination', async () => {
    let got: { name?: string; args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (name, args) => {
          got = { name, args };
          return { content: [{ type: 'text', text: '{"generators":[]}' }] };
        },
      }),
    );
    await client.callTool({ name: 'list_generators', arguments: {} });
    expect(got).toEqual({ name: 'abap_generators-list_generators', args: { destination: 'A4H' } });
  });

  it('get_generator_schema passes generatorId + destination to the federated tool', async () => {
    let got: { name?: string; args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (name, args) => {
          got = { name, args };
          return { content: [{ type: 'text', text: '{}' }] };
        },
      }),
    );
    await client.callTool({ name: 'get_generator_schema', arguments: { generatorId: 'odata_ui' } });
    expect(got).toEqual({ name: 'abap_generators-get_schema', args: { destination: 'A4H', generatorId: 'odata_ui' } });
  });

  it('get_object_type_details passes objectType + default name placeholder', async () => {
    let got: { args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (_name, args) => {
          got = { args };
          return { content: [{ type: 'text', text: '{"fields":[]}' }] };
        },
      }),
    );
    await client.callTool({ name: 'get_object_type_details', arguments: { objectType: 'CLAS/OC' } });
    expect(got.args).toEqual({ destination: 'A4H', objectType: 'CLAS/OC', name: 'Z_PLACEHOLDER' });
  });

  it('the new read tools error clearly with no destination', async () => {
    const client = await linkedClient(fakeEngine());
    for (const name of ['list_users', 'list_generators']) {
      const res = await client.callTool({ name, arguments: {} });
      expect(JSON.stringify(res.content)).toContain('No ABAP destination is connected');
    }
  });

  it('get_service_binding passes serviceBindingName + destination to the federated tool', async () => {
    let got: { name?: string; args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (name, args) => {
          got = { name, args };
          return { content: [{ type: 'text', text: '{"bindingType":"ODATA"}' }] };
        },
      }),
    );
    await client.callTool({ name: 'get_service_binding', arguments: { serviceBindingName: '/DMO/API_TRAVEL_U_V2' } });
    expect(got).toEqual({
      name: 'abap_business_services-fetch_services',
      args: { destination: 'A4H', serviceBindingName: '/DMO/API_TRAVEL_U_V2' },
    });
  });

  it('read_source delegates to engine.lifecycle.readSource', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          readSource: async (a: unknown) => {
            got = a;
            return 'CLASS zcl_x DEFINITION PUBLIC.\nENDCLASS.';
          },
        },
      }),
    );
    const res = await client.callTool({ name: 'read_source', arguments: { name: 'ZCL_X', objectType: 'CLAS/OC' } });
    expect(got).toEqual({ name: 'ZCL_X', objectType: 'CLAS/OC', include: undefined });
    expect(JSON.stringify(res.content)).toContain('CLASS zcl_x');
  });

  it('create_object maps `package` → packageName for the lifecycle', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          createObject: async (a: unknown) => ((got = a), { filePath: 'abap:/x' }),
        },
      }),
    );
    await client.callTool({
      name: 'create_object',
      arguments: { objectType: 'CLAS/OC', name: 'ZCL_X', package: '$TMP', description: 'x' },
    });
    expect(got).toEqual({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' });
  });

  it('activate_object returns {success, diagnostics}', async () => {
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          activate: async () => ({ success: false, diagnostics: [{ message: 'syntax error' }] }),
        },
      }),
    );
    const res = await client.callTool({ name: 'activate_object', arguments: { name: 'ZCL_X', objectType: 'CLAS/OC' } });
    expect(JSON.stringify(res.content)).toContain('syntax error');
  });

  it('a write tool surfaces a safety error from the lifecycle', async () => {
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          updateSource: async () => {
            throw new Error('Writes are disabled (read-only mode).');
          },
        },
      }),
    );
    const res = await client.callTool({
      name: 'update_source',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', source: 'X' },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('Writes are disabled');
  });
});
