import { describe, expect, it, vi } from 'vitest';
import type { AdtLsDriver } from '../../../src/adt-ls/driver.js';
import { getInactiveObjects, getUsers, quickSearch } from '../../../src/adt-ls/repository.js';

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
