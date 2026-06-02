import { describe, expect, it, vi } from 'vitest';
import type { AdtLsDriver } from '../../../src/adt-ls/driver.js';
import {
  getInactiveObjects,
  getLsUri,
  getUsers,
  includeAffUri,
  isUnsupportedPlaceholder,
  metadataAffUri,
  quickSearch,
} from '../../../src/adt-ls/repository.js';

function fakeDriver(reply: unknown) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const driver = {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return reply;
    }),
  } as unknown as AdtLsDriver;
  return { driver, calls };
}

describe('quickSearch', () => {
  it('sends {destination, pattern, maxResults, types} — NOT query/destinationId', async () => {
    const { driver, calls } = fakeDriver({ references: [{ name: 'CL_X', uri: '/sap/bc/adt/oo/classes/cl_x' }] });
    const r = await quickSearch(driver, { destination: 'A4H', pattern: 'CL_X*' });
    expect(calls[0]).toEqual({
      method: 'adtLs/repository/quickSearch',
      params: { destination: 'A4H', pattern: 'CL_X*', maxResults: 50, types: [] },
    });
    expect(r.references[0].name).toBe('CL_X');
  });

  it('honors maxResults + types', async () => {
    const { driver, calls } = fakeDriver({ references: [] });
    await quickSearch(driver, { destination: 'A4H', pattern: 'Z*', maxResults: 10, types: ['CLAS/OC'] });
    expect(calls[0].params).toMatchObject({ maxResults: 10, types: ['CLAS/OC'] });
  });

  it('does NOT retry on empty by default (retryOnEmptyMs unset → single call)', async () => {
    const { driver, calls } = fakeDriver({ references: [] });
    await quickSearch(driver, { destination: 'A4H', pattern: 'Z*' });
    expect(calls).toHaveLength(1);
  });

  it('retries once on an empty result when retryOnEmptyMs is set, returning the second result', async () => {
    const replies = [{ references: [] }, { references: [{ name: 'ZCL_X', uri: '/x' }] }];
    let i = 0;
    const driver = {
      sendRequest: vi.fn(async () => replies[i++]),
    } as unknown as AdtLsDriver;
    const r = await quickSearch(driver, { destination: 'A4H', pattern: 'ZCL_X' }, { retryOnEmptyMs: 1 });
    expect(driver.sendRequest).toHaveBeenCalledTimes(2);
    expect(r.references[0].name).toBe('ZCL_X');
  });

  it('does not retry when the first result is non-empty (one call even with retryOnEmptyMs)', async () => {
    const { driver } = fakeDriver({ references: [{ name: 'ZCL_X', uri: '/x' }] });
    await quickSearch(driver, { destination: 'A4H', pattern: 'ZCL_X' }, { retryOnEmptyMs: 1 });
    expect(driver.sendRequest).toHaveBeenCalledTimes(1);
  });
});

describe('getInactiveObjects', () => {
  it('sends {destinationId} (note: NOT destination)', async () => {
    const { driver, calls } = fakeDriver([]);
    await getInactiveObjects(driver, 'A4H');
    expect(calls[0]).toEqual({ method: 'adtLs/activation/getInactiveObjects', params: { destinationId: 'A4H' } });
  });
});

describe('getUsers', () => {
  it('sends {destination} and unwraps .users', async () => {
    const { driver, calls } = fakeDriver({ users: [{ id: 'DEVELOPER', text: 'John Doe' }] });
    const users = await getUsers(driver, 'A4H');
    expect(calls[0]).toEqual({ method: 'adtLs/repository/getUsers', params: { destination: 'A4H' } });
    expect(users).toEqual([{ id: 'DEVELOPER', text: 'John Doe' }]);
  });

  it('returns [] when the response has no users', async () => {
    const { driver } = fakeDriver({});
    expect(await getUsers(driver, 'A4H')).toEqual([]);
  });
});

describe('getLsUri', () => {
  it('sends {destination, adtUri} (param key is adtUri) and returns the repotree URI', async () => {
    const { driver, calls } = fakeDriver({ uri: 'abap:/repotree-v1/A4H/x.clas.abap' });
    const uri = await getLsUri(driver, 'A4H', '/sap/bc/adt/oo/classes/zcl_x');
    expect(calls[0]).toEqual({
      method: 'adtLs/repository/getLsUri',
      params: { destination: 'A4H', adtUri: '/sap/bc/adt/oo/classes/zcl_x' },
    });
    expect(uri).toBe('abap:/repotree-v1/A4H/x.clas.abap');
  });
  it('throws when no uri comes back', async () => {
    const { driver } = fakeDriver({});
    await expect(getLsUri(driver, 'A4H', '/x')).rejects.toThrow(/no uri/);
  });
});

describe('AFF URI helpers', () => {
  const main = 'abap:/repotree-v1/A4H/Classes/ZCL_X/zcl_x.clas.abap';
  it('includeAffUri swaps to the class include file', () => {
    expect(includeAffUri(main, 'definitions')).toBe('abap:/repotree-v1/A4H/Classes/ZCL_X/zcl_x.clas.definitions.abap');
    expect(includeAffUri(main, 'testclasses')).toMatch(/zcl_x\.clas\.testclasses\.abap$/);
  });
  it('metadataAffUri swaps the final extension to json', () => {
    expect(metadataAffUri(main)).toBe('abap:/repotree-v1/A4H/Classes/ZCL_X/zcl_x.clas.json');
    expect(metadataAffUri('a/b/x.ddls.acds')).toBe('a/b/x.ddls.json');
  });
  it('isUnsupportedPlaceholder detects the "use Eclipse" placeholder', () => {
    expect(isUnsupportedPlaceholder('// The object is not supported in ADT in VS Code. Please use…')).toBe(true);
    expect(isUnsupportedPlaceholder('CLASS zcl_x DEFINITION.')).toBe(false);
  });
});
