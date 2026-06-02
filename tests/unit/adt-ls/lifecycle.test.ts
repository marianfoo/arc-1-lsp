import { describe, expect, it, vi } from 'vitest';
import type { AdtLsDriver } from '../../../src/adt-ls/driver.js';
import { createLifecycle } from '../../../src/adt-ls/lifecycle.js';
import type { WriteSafety } from '../../../src/server/safety.js';

const AFF =
  'abap:/repotree-v1/A4H/Local%20Objects%20%28%24TMP%29/DEVELOPER/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap';

function fakes(opts: { readContent?: string; errorOn?: string } = {}) {
  const lsp: Array<{ method: string; params: unknown }> = [];
  const fed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const driver = {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      lsp.push({ method, params });
      switch (method) {
        case 'adtLs/repository/quickSearch':
          return { references: [{ name: 'ZCL_X', type: 'Class', uri: '/sap/bc/adt/oo/classes/zcl_x' }] };
        case 'adtLs/repository/getLsUri':
          return { uri: AFF };
        case 'adtLs/fileSystem/readFile':
          return { content: opts.readContent ?? 'CLASS zcl_x DEFINITION PUBLIC.\nENDCLASS.' };
        case 'adtLs/cts/transport/searchTransports':
          return [{ number: 'A4HK900001', description: 'WIP', owner: 'DEVELOPER' }];
        case 'adtLs/fileSystem/getFileLockStatus':
          return { lockingSupported: true, lockId: null };
        case 'adtLs/cts/transport/assignTransportToObject':
          return true;
        default:
          return null; // writeFile, delete
      }
    }),
  } as unknown as AdtLsDriver;
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    fed.push({ name, args });
    if (opts.errorOn && name === opts.errorOn) return { isError: true, content: [{ text: 'boom' }] };
    if (name === 'abap_creation-create_object')
      return { structuredContent: { message: 'ABAP Class created successfully', filePath: AFF }, isError: false };
    if (name === 'abap_activate_objects')
      return { structuredContent: { success: true, objectDiagnostics: [] }, isError: false };
    if (name === 'abap_run_unit_tests') return { content: [{ text: 'No tests found' }], isError: false };
    if (name === 'abap_generators-generate_objects')
      return { structuredContent: { generatedObjects: ['ZI_X'] }, isError: false };
    if (name === 'abap_creation-run_validation') return { structuredContent: { valid: true }, isError: false };
    if (name === 'abap_transport-get') return { structuredContent: { transports: [] }, isError: false };
    if (name === 'abap_transport-create')
      return { structuredContent: { transportRequestNumber: 'A4HK900123' }, isError: false };
    return {};
  });
  const make = (safety: WriteSafety) => createLifecycle({ driver, callTool, destination: () => 'A4H', safety });
  return { make, lsp, fed, driver, callTool };
}
const WRITES_OFF: WriteSafety = { allowWrites: false, allowTransportWrites: false, allowedPackages: ['$TMP'] };
const WRITES_ON: WriteSafety = { allowWrites: true, allowTransportWrites: false, allowedPackages: ['$TMP'] };
const TRANSPORT_ON: WriteSafety = { allowWrites: true, allowTransportWrites: true, allowedPackages: ['*'] };

describe('lifecycle.resolveAffUri', () => {
  it('searches by name+type then getLsUri with adtUri → repotree URI', async () => {
    const f = fakes();
    const uri = await f.make(WRITES_OFF).resolveAffUri({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(uri).toBe(AFF);
    expect(f.lsp[0]).toMatchObject({
      method: 'adtLs/repository/quickSearch',
      params: { pattern: 'ZCL_X', types: ['CLAS/OC'] },
    });
    expect(f.lsp[1]).toEqual({
      method: 'adtLs/repository/getLsUri',
      params: { destination: 'A4H', adtUri: '/sap/bc/adt/oo/classes/zcl_x' },
    });
  });
});

describe('lifecycle.resolveAffUri dead-session revival', () => {
  it('revives a dead session on an empty search, then resolves on the retry', async () => {
    let revived = false;
    const driver = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'adtLs/repository/quickSearch') {
          // dead session returns [] until the re-logon flips it
          return revived
            ? { references: [{ name: 'ZCL_X', uri: '/sap/bc/adt/oo/classes/zcl_x' }] }
            : { references: [] };
        }
        if (method === 'adtLs/repository/getLsUri') return { uri: AFF };
        return null;
      }),
    } as unknown as AdtLsDriver;
    const reviveIfDead = vi.fn(async () => {
      revived = true;
      return true;
    });
    const life = createLifecycle({
      driver,
      callTool: vi.fn(),
      destination: () => 'A4H',
      safety: WRITES_OFF,
      reviveIfDead,
    });
    expect(await life.resolveAffUri({ name: 'ZCL_X', objectType: 'CLAS/OC' })).toBe(AFF);
    expect(reviveIfDead).toHaveBeenCalledTimes(1);
  });

  it('does NOT revive when the object is genuinely absent (revive reports the session alive)', async () => {
    const driver = {
      sendRequest: vi.fn(async () => ({ references: [] })),
    } as unknown as AdtLsDriver;
    const reviveIfDead = vi.fn(async () => false); // probe says alive → genuine not-found
    const life = createLifecycle({
      driver,
      callTool: vi.fn(),
      destination: () => 'A4H',
      safety: WRITES_OFF,
      reviveIfDead,
    });
    await expect(life.resolveAffUri({ name: 'ZNOPE', objectType: 'CLAS/OC' })).rejects.toThrow(/not found/);
    expect(reviveIfDead).toHaveBeenCalledTimes(1);
  });
});

describe('lifecycle.readSource', () => {
  it('returns the source', async () => {
    expect(await fakes().make(WRITES_OFF).readSource({ name: 'ZCL_X', objectType: 'CLAS/OC' })).toContain(
      'CLASS zcl_x',
    );
  });
  it('reads a class include via the .clas.<include>.abap file', async () => {
    const f = fakes();
    await f.make(WRITES_OFF).readSource({ name: 'ZCL_X', objectType: 'CLAS/OC', include: 'definitions' });
    const read = f.lsp.find((c) => c.method === 'adtLs/fileSystem/readFile');
    expect((read?.params as { uri: string }).uri).toMatch(/zcl_x\.clas\.definitions\.abap$/);
  });
  it('throws a clear error for classic types adt-ls cannot serve', async () => {
    const f = fakes({ readContent: '// The object is not supported in ADT in VS Code. Please use ADT in Eclipse' });
    await expect(f.make(WRITES_OFF).readSource({ name: 'ZFOO', objectType: 'PROG/P' })).rejects.toThrow(
      /not served by adt-ls headless/,
    );
  });
});

describe('lifecycle write-safety', () => {
  it('createObject is blocked when writes are off', async () => {
    await expect(
      fakes()
        .make(WRITES_OFF)
        .createObject({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' }),
    ).rejects.toThrow(/Writes are disabled/);
  });
  it('createObject blocks a disallowed package even with writes on', async () => {
    await expect(
      fakes()
        .make(WRITES_ON)
        .createObject({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: 'ZPROD', description: 'x' }),
    ).rejects.toThrow(/not in the write allowlist/);
  });
  it('createObject sends objectContent as a JSON string + returns filePath', async () => {
    const f = fakes();
    const r = await f
      .make(WRITES_ON)
      .createObject({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' });
    expect(r.filePath).toBe(AFF);
    const call = f.fed.find((c) => c.name === 'abap_creation-create_object');
    expect(typeof call?.args.objectContent).toBe('string');
    expect(JSON.parse(call?.args.objectContent as string)).toEqual({
      name: 'ZCL_X',
      packageName: '$TMP',
      description: 'x',
    });
  });
  it('createObject sends transportRequestNumber as a top-level arg (default "", explicit forwarded)', async () => {
    const f = fakes();
    await f
      .make(WRITES_ON)
      .createObject({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' });
    expect(f.fed.find((c) => c.name === 'abap_creation-create_object')?.args.transportRequestNumber).toBe('');

    const f2 = fakes();
    await f2.make(WRITES_ON).createObject({
      objectType: 'CLAS/OC',
      name: 'ZCL_X',
      packageName: '$TMP',
      description: 'x',
      transportRequestNumber: 'A4HK900999',
    });
    expect(f2.fed.find((c) => c.name === 'abap_creation-create_object')?.args.transportRequestNumber).toBe(
      'A4HK900999',
    );
  });
  it('updateSource is gated + writes to the resolved URI', async () => {
    const f = fakes();
    await expect(
      f.make(WRITES_OFF).updateSource({ name: 'ZCL_X', objectType: 'CLAS/OC', source: 'X' }),
    ).rejects.toThrow(/disabled/);
    await f.make(WRITES_ON).updateSource({ name: 'ZCL_X', objectType: 'CLAS/OC', source: 'NEW SOURCE' });
    const w = f.lsp.find((c) => c.method === 'adtLs/fileSystem/writeFile');
    expect(w?.params).toEqual({ uri: AFF, content: 'NEW SOURCE' });
  });
  it('deleteObject is gated + deletes the .clas.json metadata file', async () => {
    const f = fakes();
    await f.make(WRITES_ON).deleteObject({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    const del = f.lsp.find((c) => c.method === 'adtLs/fileSystem/delete');
    expect((del?.params as { uri: string }).uri).toMatch(/zcl_x\.clas\.json$/);
  });
  it('activate is gated + returns {success, diagnostics}', async () => {
    const f = fakes();
    const r = await f.make(WRITES_ON).activate({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(r).toEqual({ success: true, diagnostics: [] });
  });
});

describe('lifecycle non-mutating', () => {
  it('runUnitTests works even with writes off (no gate) + wraps a bare string into {message}', async () => {
    const r = await fakes().make(WRITES_OFF).runUnitTests({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    // adt-ls returns a bare "No tests found" string; normalized to a JSON object.
    expect(r).toEqual({ message: 'No tests found' });
  });
  it('validateObject is ungated + sends objectContent JSON to run_validation', async () => {
    const f = fakes();
    await f
      .make(WRITES_OFF)
      .validateObject({ objectType: 'CLAS/OC', name: 'ZCL_X', packageName: '$TMP', description: 'x' });
    const call = f.fed.find((c) => c.name === 'abap_creation-run_validation');
    expect(call?.args.destination).toBe('A4H');
    expect(call?.args.objectType).toBe('CLAS/OC');
    expect(JSON.parse(call?.args.objectContent as string)).toEqual({
      name: 'ZCL_X',
      packageName: '$TMP',
      description: 'x',
    });
  });
  it('findTransport is ungated + sends object-scoped args to abap_transport-get', async () => {
    const f = fakes();
    await f
      .make(WRITES_OFF)
      .findTransport({ objectName: 'ZCL_X', objectType: 'CLAS/OC', developmentPackage: 'ZFOO', isCreation: true });
    expect(f.fed.find((c) => c.name === 'abap_transport-get')?.args).toEqual({
      destination: 'A4H',
      objectName: 'ZCL_X',
      objectType: 'CLAS/OC',
      developmentPackage: 'ZFOO',
      isCreation: true,
    });
  });
});

describe('lifecycle generation', () => {
  it('generateObjects is gated by writes + package, then sends all args (refs/transport default "")', async () => {
    const f = fakes();
    await expect(
      f.make(WRITES_OFF).generateObjects({ generatorId: 'x-ui-service', content: '{}', packageName: '$TMP' }),
    ).rejects.toThrow(/Writes are disabled/);
    await expect(
      f.make(WRITES_ON).generateObjects({ generatorId: 'x-ui-service', content: '{}', packageName: 'ZPROD' }),
    ).rejects.toThrow(/not in the write allowlist/);

    const f2 = fakes();
    await f2.make(WRITES_ON).generateObjects({
      generatorId: 'x-ui-service',
      content: '{"name":"X"}',
      packageName: '$TMP',
      referencedObjectType: 'TABL',
      referencedObjectName: 'SCARR',
    });
    expect(f2.fed.find((c) => c.name === 'abap_generators-generate_objects')?.args).toEqual({
      destination: 'A4H',
      generatorId: 'x-ui-service',
      content: '{"name":"X"}',
      packageName: '$TMP',
      transportRequestNumber: '',
      referencedObjectType: 'TABL',
      referencedObjectName: 'SCARR',
    });
  });
  it('generateObjects throws when adt-ls signals isError', async () => {
    const f = fakes({ errorOn: 'abap_generators-generate_objects' });
    await expect(
      f.make(WRITES_ON).generateObjects({ generatorId: 'x-ui-service', content: '{}', packageName: '$TMP' }),
    ).rejects.toThrow(/generate_objects failed: boom/);
  });
});

describe('lifecycle transport writes', () => {
  it('createTransport needs writes AND transport-writes, then calls abap_transport-create', async () => {
    await expect(
      fakes()
        .make(WRITES_OFF)
        .createTransport({ developmentPackage: 'ZFOO', transportDescription: 'd', isCreation: true }),
    ).rejects.toThrow(/Writes are disabled/);
    await expect(
      fakes()
        .make(WRITES_ON)
        .createTransport({ developmentPackage: 'ZFOO', transportDescription: 'd', isCreation: true }),
    ).rejects.toThrow(/Transport writes are disabled/);

    const f = fakes();
    const r = await f.make(TRANSPORT_ON).createTransport({
      developmentPackage: 'ZFOO',
      transportDescription: 'My change',
      isCreation: true,
      objectName: 'ZCL_X',
      objectType: 'CLAS/OC',
    });
    expect(JSON.stringify(r)).toContain('A4HK900123');
    expect(f.fed.find((c) => c.name === 'abap_transport-create')?.args).toEqual({
      destination: 'A4H',
      developmentPackage: 'ZFOO',
      transportDescription: 'My change',
      isCreation: true,
      objectName: 'ZCL_X',
      objectType: 'CLAS/OC',
    });
  });
  it('createTransport omits optional object args when not given', async () => {
    const f = fakes();
    await f
      .make(TRANSPORT_ON)
      .createTransport({ developmentPackage: 'ZFOO', transportDescription: 'd', isCreation: false });
    expect(f.fed.find((c) => c.name === 'abap_transport-create')?.args).toEqual({
      destination: 'A4H',
      developmentPackage: 'ZFOO',
      transportDescription: 'd',
      isCreation: false,
    });
  });
  it('createTransport runs developmentPackage through the package allowlist', async () => {
    await expect(
      fakes()
        .make({ allowWrites: true, allowTransportWrites: true, allowedPackages: ['$TMP'] })
        .createTransport({ developmentPackage: 'ZPROD', transportDescription: 'd', isCreation: true }),
    ).rejects.toThrow(/not in the write allowlist/);
  });
  it('createTransport refuses a local ($-prefixed) package (would orphan a useless TR)', async () => {
    const f = fakes();
    await expect(
      f.make(TRANSPORT_ON).createTransport({ developmentPackage: '$TMP', transportDescription: 'd', isCreation: true }),
    ).rejects.toThrow(/local \(non-transportable\)/);
    // it must NOT have called the backend create
    expect(f.fed.some((c) => c.name === 'abap_transport-create')).toBe(false);
  });

  it('createTransport throws when adt-ls signals isError', async () => {
    const f = fakes({ errorOn: 'abap_transport-create' });
    await expect(
      f.make(TRANSPORT_ON).createTransport({ developmentPackage: 'ZFOO', transportDescription: 'd', isCreation: true }),
    ).rejects.toThrow(/create_transport failed: boom/);
  });
});

describe('lifecycle native transport + lock', () => {
  it('listTransports is ungated + queries native searchTransports with the destination', async () => {
    const f = fakes();
    const r = await f.make(WRITES_OFF).listTransports();
    expect(JSON.stringify(r)).toContain('A4HK900001');
    expect(f.lsp.find((c) => c.method === 'adtLs/cts/transport/searchTransports')?.params).toEqual({
      destinationId: 'A4H',
    });
  });

  it('getLockStatus is ungated + resolves the AFF uri then queries getFileLockStatus', async () => {
    const f = fakes();
    const r = (await f.make(WRITES_OFF).getLockStatus({ name: 'ZCL_X', objectType: 'CLAS/OC' })) as {
      lockId: unknown;
    };
    expect(r.lockId).toBeNull();
    expect(f.lsp.find((c) => c.method === 'adtLs/fileSystem/getFileLockStatus')?.params).toEqual({ uri: AFF });
  });

  it('getLockStatus fills lockId:null even when adt-ls omits the key (unlocked)', async () => {
    const driver = {
      sendRequest: vi.fn(async (method: string) => {
        if (method === 'adtLs/repository/quickSearch')
          return { references: [{ name: 'ZCL_X', uri: '/sap/bc/adt/oo/classes/zcl_x' }] };
        if (method === 'adtLs/repository/getLsUri') return { uri: AFF };
        if (method === 'adtLs/fileSystem/getFileLockStatus') return { lockingSupported: true }; // no lockId key
        return null;
      }),
    } as unknown as AdtLsDriver;
    const life = createLifecycle({ driver, callTool: vi.fn(), destination: () => 'A4H', safety: WRITES_OFF });
    expect(await life.getLockStatus({ name: 'ZCL_X', objectType: 'CLAS/OC' })).toEqual({
      lockingSupported: true,
      lockId: null,
    });
  });

  it('assignTransport needs writes AND transport-writes, then sends objectUri + transport (structured result)', async () => {
    await expect(
      fakes().make(WRITES_OFF).assignTransport({ name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'A4HK900123' }),
    ).rejects.toThrow(/Writes are disabled/);
    await expect(
      fakes().make(WRITES_ON).assignTransport({ name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'A4HK900123' }),
    ).rejects.toThrow(/Transport writes are disabled/);

    const f = fakes();
    const r = await f
      .make(TRANSPORT_ON)
      .assignTransport({ name: 'ZCL_X', objectType: 'CLAS/OC', transport: 'A4HK900123' });
    // Wrapped, self-describing result — not a naked boolean.
    expect(r).toEqual({ assigned: true, object: 'ZCL_X', objectType: 'CLAS/OC', transport: 'A4HK900123' });
    expect(f.lsp.find((c) => c.method === 'adtLs/cts/transport/assignTransportToObject')?.params).toEqual({
      objectUri: AFF,
      transport: 'A4HK900123',
    });
  });
});

describe('lifecycle.listTransports shaping (token-bomb guard)', () => {
  function makeWith(transportsReply: unknown) {
    const driver = {
      sendRequest: vi.fn(async (method: string) =>
        method === 'adtLs/cts/transport/searchTransports' ? transportsReply : null,
      ),
    } as unknown as AdtLsDriver;
    return createLifecycle({ driver, callTool: vi.fn(), destination: () => 'A4H', safety: WRITES_OFF });
  }
  const rows = Array.from({ length: 250 }, (_, i) => ({
    number: `A4HK${900000 + i}`,
    description: i === 7 ? 'special wip' : `req ${i}`,
    owner: 'DEVELOPER',
  }));

  it('caps to the default limit (100) and reports totals + truncated', async () => {
    const r = (await makeWith(rows).listTransports()) as {
      total: number;
      returned: number;
      truncated: boolean;
      transports: unknown[];
    };
    expect(r.total).toBe(250);
    expect(r.returned).toBe(100);
    expect(r.truncated).toBe(true);
    expect(r.transports).toHaveLength(100);
  });

  it('honors an explicit limit', async () => {
    expect(((await makeWith(rows).listTransports({ limit: 5 })) as { returned: number }).returned).toBe(5);
  });

  it('filters client-side by query (case-insensitive substring across fields)', async () => {
    const r = (await makeWith(rows).listTransports({ query: 'SPECIAL' })) as {
      matched: number;
      transports: Array<{ description: string }>;
    };
    expect(r.matched).toBe(1);
    expect(r.transports[0].description).toBe('special wip');
  });

  it('normalizes a {transports:[...]} envelope', async () => {
    expect(((await makeWith({ transports: rows.slice(0, 3) }).listTransports()) as { total: number }).total).toBe(3);
  });

  it('returns an unrecognized non-array shape verbatim (never hides data)', async () => {
    const weird = { error: 'unexpected' };
    expect(await makeWith(weird).listTransports()).toEqual(weird);
  });

  it('retries the CTS cold-window "Internal error" then returns the shaped result', async () => {
    let i = 0;
    const driver = {
      sendRequest: vi.fn(async (method: string) => {
        if (method !== 'adtLs/cts/transport/searchTransports') return null;
        if (i++ === 0) throw new Error('Internal error'); // cold throw on the first call
        return rows.slice(0, 2);
      }),
    } as unknown as AdtLsDriver;
    const life = createLifecycle({ driver, callTool: vi.fn(), destination: () => 'A4H', safety: WRITES_OFF });
    expect(((await life.listTransports()) as { total: number }).total).toBe(2);
    expect(driver.sendRequest).toHaveBeenCalledTimes(2); // failed once, retried, succeeded
  });

  it('revives a dead session when the CTS "Internal error" survives cold-retry', async () => {
    let healed = false;
    const driver = {
      sendRequest: vi.fn(async (method: string) => {
        if (method !== 'adtLs/cts/transport/searchTransports') return null;
        if (!healed) throw new Error('Internal error'); // dead session: never recovers by retry
        return rows.slice(0, 2);
      }),
    } as unknown as AdtLsDriver;
    const reviveIfDead = vi.fn(async () => {
      healed = true;
      return true;
    });
    const life = createLifecycle({
      driver,
      callTool: vi.fn(),
      destination: () => 'A4H',
      safety: WRITES_OFF,
      reviveIfDead,
    });
    expect(((await life.listTransports()) as { total: number }).total).toBe(2);
    expect(reviveIfDead).toHaveBeenCalledTimes(1); // cold-retry exhausted → revived → retried
  });
});
