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
      generateObjects: async () => ({ generatedObjects: ['ZI_X'] }),
      validateObject: async () => ({ valid: true }),
      findTransport: async () => ({ transports: [] }),
      createTransport: async () => ({ transportRequestNumber: 'A4HK900123' }),
    },
    lsp: { sendRequest: async () => ({}), sendNotification: async () => {} },
    navigation: {
      documentSymbols: async () => [{ name: 'ZCL_X', kind: 5 }],
      checkSyntax: async () => ({ kind: 'full', items: [] }),
      goToDefinition: async () => [{ targetUri: 'abap:/x' }],
      goToDeclaration: async () => [{ targetUri: 'abap:/x' }],
      hover: async () => ({ contents: { kind: 'markdown', value: 'METHOD run' } }),
      documentHighlight: async () => [{ range: {}, kind: 1 }],
      findReferences: async () => [{ uri: 'abap:/x' }],
      typeHierarchy: async () => ({ item: { name: 'ZCL_X' }, supertypes: [], subtypes: [] }),
      completion: async () => ({ isIncomplete: false, total: 0, items: [] }),
    },
    quality: {
      runAtc: async () => ({ atcRunCheckResults: [] }),
      listAtcVariants: async () => ({ checkVariants: {} }),
      runUnitTestsWithCoverage: async () => ({ status: null, result: null, coverage: null }),
    },
    services: {
      runApplication: async () => ({ output: 'ran' }),
      serviceBindingDetails: async () => ({ serviceBindingName: 'Z_BIND', odataversion: 'V4' }),
      publishServiceBinding: async () => ({ isExecuted: true, isPublishSuccess: true }),
    },
    reconnect: async () => true,
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
      'check_syntax',
      'completion',
      'create_object',
      'create_transport',
      'delete_object',
      'document_highlight',
      'document_symbols',
      'find_references',
      'find_transport',
      'generate_objects',
      'get_generator_schema',
      'get_object_type_details',
      'get_service_binding',
      'get_service_details',
      'go_to_declaration',
      'go_to_definition',
      'health',
      'hover',
      'list_atc_variants',
      'list_creatable_objects',
      'list_destinations',
      'list_generators',
      'list_inactive_objects',
      'list_users',
      'publish_service_binding',
      'read_source',
      'run_application',
      'run_atc',
      'run_unit_tests',
      'run_unit_tests_with_coverage',
      'search_objects',
      'service_binding_details',
      'type_hierarchy',
      'update_source',
      'validate_object',
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

  it('get_generator_schema passes generatorId + destination + default $TMP packageName', async () => {
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
    expect(got).toEqual({
      name: 'abap_generators-get_schema',
      // all 5 args are required by adt-ls; refs default to "" (object-less generators)
      args: {
        destination: 'A4H',
        generatorId: 'odata_ui',
        packageName: '$TMP',
        referencedObjectType: '',
        referencedObjectName: '',
      },
    });
  });

  it('get_generator_schema forwards explicit package + referenced object', async () => {
    let got: { args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (_name, args) => {
          got = { args };
          return { content: [{ type: 'text', text: '{}' }] };
        },
      }),
    );
    await client.callTool({
      name: 'get_generator_schema',
      arguments: {
        generatorId: 'x-ui-service',
        package: 'ZFOO',
        referencedObjectType: 'TABL',
        referencedObjectName: 'SCARR',
      },
    });
    expect(got.args).toEqual({
      destination: 'A4H',
      generatorId: 'x-ui-service',
      packageName: 'ZFOO',
      referencedObjectType: 'TABL',
      referencedObjectName: 'SCARR',
    });
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
          createObject: async (a: unknown) => {
            got = a;
            return { filePath: 'abap:/x' };
          },
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

  it('generate_objects maps package→packageName + transport→transportRequestNumber for the lifecycle', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          generateObjects: async (a: unknown) => {
            got = a;
            return { generatedObjects: ['ZI_X'] };
          },
        },
      }),
    );
    await client.callTool({
      name: 'generate_objects',
      arguments: {
        generatorId: 'x-ui-service',
        content: '{"a":1}',
        package: '$TMP',
        referencedObjectType: 'TABL',
        referencedObjectName: 'SCARR',
      },
    });
    expect(got).toEqual({
      generatorId: 'x-ui-service',
      content: '{"a":1}',
      packageName: '$TMP',
      transportRequestNumber: undefined,
      referencedObjectType: 'TABL',
      referencedObjectName: 'SCARR',
    });
  });

  it('validate_object maps package→packageName for the lifecycle', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          validateObject: async (a: unknown) => {
            got = a;
            return { valid: true };
          },
        },
      }),
    );
    await client.callTool({
      name: 'validate_object',
      arguments: { objectType: 'CLAS/OC', name: 'ZCL_X', package: '$TMP', description: 'x' },
    });
    expect(got).toEqual({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' });
  });

  it('find_transport passes object-scoped args to the lifecycle', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          findTransport: async (a: unknown) => {
            got = a;
            return { transports: [] };
          },
        },
      }),
    );
    await client.callTool({
      name: 'find_transport',
      arguments: { objectName: 'ZCL_X', objectType: 'CLAS/OC', developmentPackage: 'ZFOO', isCreation: true },
    });
    expect(got).toEqual({ objectName: 'ZCL_X', objectType: 'CLAS/OC', developmentPackage: 'ZFOO', isCreation: true });
  });

  it('create_transport passes args to the lifecycle and returns the TR', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        lifecycle: {
          ...fakeEngine().lifecycle,
          createTransport: async (a: unknown) => {
            got = a;
            return { transportRequestNumber: 'A4HK900123' };
          },
        },
      }),
    );
    const res = await client.callTool({
      name: 'create_transport',
      arguments: { developmentPackage: 'ZFOO', transportDescription: 'My change', isCreation: true },
    });
    expect(got).toEqual({
      developmentPackage: 'ZFOO',
      transportDescription: 'My change',
      isCreation: true,
      objectName: undefined,
      objectType: undefined,
    });
    expect(JSON.stringify(res.content)).toContain('A4HK900123');
  });

  it('get_service_details federates to fetch_service_information with the connected destination', async () => {
    let got: { name?: string; args?: Record<string, unknown> } = {};
    const client = await linkedClient(
      fakeEngine({
        connectedDestination: 'A4H',
        callTool: async (name, args) => {
          got = { name, args };
          return { content: [{ type: 'text', text: '{"odataUrl":"/x"}' }] };
        },
      }),
    );
    await client.callTool({
      name: 'get_service_details',
      arguments: {
        serviceBindingName: 'B',
        serviceName: 'S',
        serviceDefinition: 'D',
        serviceVersion: '0001',
        odataInfoUri: '/info',
        odataVersion: 'V4',
      },
    });
    expect(got.name).toBe('abap_business_services-fetch_service_information');
    expect(got.args).toMatchObject({
      destination: 'A4H',
      serviceBindingName: 'B',
      serviceName: 'S',
      odataVersion: 'V4',
    });
  });

  it('get_service_details errors clearly with no destination', async () => {
    const client = await linkedClient(fakeEngine());
    const res = await client.callTool({
      name: 'get_service_details',
      arguments: {
        serviceBindingName: 'B',
        serviceName: 'S',
        serviceDefinition: 'D',
        serviceVersion: '0001',
        odataInfoUri: '/info',
        odataVersion: 'V4',
      },
    });
    expect(JSON.stringify(res.content)).toContain('No ABAP destination is connected');
  });

  it('document_symbols delegates to engine.navigation.documentSymbols', async () => {
    let got: unknown;
    const client = await linkedClient(
      fakeEngine({
        navigation: {
          ...fakeEngine().navigation,
          documentSymbols: async (a: unknown) => {
            got = a;
            return [{ name: 'ZCL_X', kind: 5 }];
          },
        },
      }),
    );
    const res = await client.callTool({
      name: 'document_symbols',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC' },
    });
    expect(got).toEqual({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(JSON.stringify(res.content)).toContain('ZCL_X');
  });

  it('go_to_definition passes the object ref + locator to navigation', async () => {
    let got: { ref?: unknown; loc?: unknown } = {};
    const client = await linkedClient(
      fakeEngine({
        navigation: {
          ...fakeEngine().navigation,
          goToDefinition: async (ref: unknown, loc: unknown) => {
            got = { ref, loc };
            return [{ targetUri: 'abap:/x' }];
          },
        },
      }),
    );
    await client.callTool({
      name: 'go_to_definition',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', symbol: 'RUN' },
    });
    expect(got.ref).toEqual({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(got.loc).toEqual({ symbol: 'RUN', line: undefined, character: undefined });
  });

  it('hover passes the object ref + locator to navigation.hover', async () => {
    let got: { ref?: unknown; loc?: unknown } = {};
    const client = await linkedClient(
      fakeEngine({
        navigation: {
          ...fakeEngine().navigation,
          hover: async (ref: unknown, loc: unknown) => {
            got = { ref, loc };
            return { contents: { kind: 'markdown', value: 'METHOD run' } };
          },
        },
      }),
    );
    const res = await client.callTool({
      name: 'hover',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', symbol: 'RUN' },
    });
    expect(got.ref).toEqual({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(got.loc).toEqual({ symbol: 'RUN', line: undefined, character: undefined });
    expect(JSON.stringify(res.content)).toContain('METHOD run');
  });

  it('document_highlight + go_to_declaration delegate to navigation', async () => {
    let highlightLoc: unknown;
    let declLoc: unknown;
    const client = await linkedClient(
      fakeEngine({
        navigation: {
          ...fakeEngine().navigation,
          documentHighlight: async (_ref: unknown, loc: unknown) => {
            highlightLoc = loc;
            return [{ range: {}, kind: 2 }];
          },
          goToDeclaration: async (_ref: unknown, loc: unknown) => {
            declLoc = loc;
            return [{ targetUri: 'abap:/x' }];
          },
        },
      }),
    );
    await client.callTool({
      name: 'document_highlight',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', line: 4, character: 7 },
    });
    await client.callTool({
      name: 'go_to_declaration',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', symbol: 'RUN' },
    });
    expect(highlightLoc).toEqual({ symbol: undefined, line: 4, character: 7 });
    expect(declLoc).toEqual({ symbol: 'RUN', line: undefined, character: undefined });
  });

  it('run_atc passes the ref + checkVariant to engine.quality.runAtc', async () => {
    let got: { ref?: unknown; opts?: unknown } = {};
    const client = await linkedClient(
      fakeEngine({
        quality: {
          ...fakeEngine().quality,
          runAtc: async (ref: unknown, opts: unknown) => {
            got = { ref, opts };
            return { atcRunCheckResults: [{ checkId: 'X', priority: 2 }] };
          },
        },
      }),
    );
    const res = await client.callTool({
      name: 'run_atc',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', checkVariant: 'DEFAULT' },
    });
    expect(got.ref).toEqual({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(got.opts).toEqual({ checkVariant: 'DEFAULT' });
    expect(JSON.stringify(res.content)).toContain('atcRunCheckResults');
  });

  it('list_atc_variants + run_unit_tests_with_coverage delegate to engine.quality', async () => {
    let variantArgs: unknown;
    let coverageRef: unknown;
    const client = await linkedClient(
      fakeEngine({
        quality: {
          ...fakeEngine().quality,
          listAtcVariants: async (_ref: unknown, opts: unknown) => {
            variantArgs = opts;
            return { checkVariants: { DEFAULT: 'Default' } };
          },
          runUnitTestsWithCoverage: async (ref: unknown) => {
            coverageRef = ref;
            return { status: null, result: null, coverage: [{ name: 'ZCL_X' }] };
          },
        },
      }),
    );
    await client.callTool({
      name: 'list_atc_variants',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', query: 'c' },
    });
    const cov = await client.callTool({
      name: 'run_unit_tests_with_coverage',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC' },
    });
    expect(variantArgs).toEqual({ query: 'c' });
    expect(coverageRef).toEqual({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(JSON.stringify(cov.content)).toContain('coverage');
  });

  it('run_application + service_binding tools delegate to engine.services', async () => {
    let runRef: unknown;
    let detailsRef: unknown;
    let publishRef: unknown;
    const client = await linkedClient(
      fakeEngine({
        services: {
          ...fakeEngine().services,
          runApplication: async (ref: unknown) => {
            runRef = ref;
            return { output: 'Hello 42' };
          },
          serviceBindingDetails: async (ref: unknown) => {
            detailsRef = ref;
            return { serviceBindingName: 'Z_BIND' };
          },
          publishServiceBinding: async (ref: unknown) => {
            publishRef = ref;
            return { isExecuted: true, isPublishSuccess: true };
          },
        },
      }),
    );
    const run = await client.callTool({
      name: 'run_application',
      arguments: { name: 'Z_RUN', objectType: 'CLAS/OC' },
    });
    await client.callTool({ name: 'service_binding_details', arguments: { name: 'Z_BIND' } });
    await client.callTool({ name: 'publish_service_binding', arguments: { name: 'Z_BIND' } });
    expect(runRef).toEqual({ name: 'Z_RUN', objectType: 'CLAS/OC' });
    expect(JSON.stringify(run.content)).toContain('Hello 42');
    // srvb tools hardcode the SRVB/SVB type so callers only pass the binding name
    expect(detailsRef).toEqual({ name: 'Z_BIND', objectType: 'SRVB/SVB' });
    expect(publishRef).toEqual({ name: 'Z_BIND', objectType: 'SRVB/SVB' });
  });

  it('publish_service_binding surfaces a read-only safety error', async () => {
    const client = await linkedClient(
      fakeEngine({
        services: {
          ...fakeEngine().services,
          publishServiceBinding: async () => {
            throw new Error('Writes are disabled (read-only mode).');
          },
        },
      }),
    );
    const res = await client.callTool({ name: 'publish_service_binding', arguments: { name: 'Z_BIND' } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('Writes are disabled');
  });

  it('type_hierarchy forwards the direction option', async () => {
    let opts: unknown;
    const client = await linkedClient(
      fakeEngine({
        navigation: {
          ...fakeEngine().navigation,
          typeHierarchy: async (_ref: unknown, _loc: unknown, o: unknown) => {
            opts = o;
            return { item: null, supertypes: [], subtypes: [] };
          },
        },
      }),
    );
    await client.callTool({
      name: 'type_hierarchy',
      arguments: { name: 'ZCL_X', objectType: 'CLAS/OC', symbol: 'ZCL_X', direction: 'subtypes' },
    });
    expect(opts).toEqual({ direction: 'subtypes' });
  });
});
