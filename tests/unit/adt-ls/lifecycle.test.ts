import { describe, expect, it, vi } from 'vitest';
import type { AdtLsDriver } from '../../../src/adt-ls/driver.js';
import { createLifecycle } from '../../../src/adt-ls/lifecycle.js';
import type { WriteSafety } from '../../../src/server/safety.js';

const AFF =
  'abap:/repotree-v1/A4H/Local%20Objects%20%28%24TMP%29/DEVELOPER/Source%20Code%20Library/Classes/ZCL_X/zcl_x.clas.abap';

function fakes(opts: { readContent?: string } = {}) {
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
        default:
          return null; // writeFile, delete
      }
    }),
  } as unknown as AdtLsDriver;
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
    fed.push({ name, args });
    if (name === 'abap_creation-create_object')
      return { structuredContent: { message: 'ABAP Class created successfully', filePath: AFF }, isError: false };
    if (name === 'abap_activate_objects')
      return { structuredContent: { success: true, objectDiagnostics: [] }, isError: false };
    if (name === 'abap_run_unit_tests') return { content: [{ text: 'No tests found' }], isError: false };
    return {};
  });
  const make = (safety: WriteSafety) => createLifecycle({ driver, callTool, destination: () => 'A4H', safety });
  return { make, lsp, fed, driver, callTool };
}
const WRITES_OFF: WriteSafety = { allowWrites: false, allowedPackages: ['$TMP'] };
const WRITES_ON: WriteSafety = { allowWrites: true, allowedPackages: ['$TMP'] };

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
  it('runUnitTests works even with writes off (no gate)', async () => {
    const r = await fakes().make(WRITES_OFF).runUnitTests({ name: 'ZCL_X', objectType: 'CLAS/OC' });
    expect(JSON.stringify(r)).toContain('No tests found');
  });
});
