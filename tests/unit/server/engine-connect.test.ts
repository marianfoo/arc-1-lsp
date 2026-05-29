import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdtLsDriver } from '../../../src/adt-ls/driver.js';
import type { TlsReverseProxy } from '../../../src/adt-ls/tls-reverse-proxy.js';
import type { SapTargetConfig } from '../../../src/server/config.js';
import { connectDestination } from '../../../src/server/engine.js';

const target: SapTargetConfig = {
  destinationId: 'A4H',
  host: 'a4h.example.com',
  port: 50001,
  user: 'DEVELOPER',
  password: 'secret',
  client: '001',
  language: 'EN',
  insecure: true,
};

function fakeDriver(logonState: string) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const driver = {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'adtLs/destinations/ensureLoggedOn') return { destinationId: 'A4H', logonState };
      return {};
    }),
  } as unknown as AdtLsDriver;
  return { driver, calls };
}

const proxy = { url: 'https://localhost:49999', port: 49999, close: async () => {} } as TlsReverseProxy;

describe('connectDestination', () => {
  let work: string;
  afterEach(async () => {
    if (work) await fsp.rm(work, { recursive: true, force: true });
  });

  it('runs initializeService → create → ensureLoggedOn → setDestination and returns the id', async () => {
    work = await fsp.mkdtemp(path.join(os.tmpdir(), 'arc1-engine-test-'));
    const { driver, calls } = fakeDriver('connected');
    const id = await connectDestination(driver, target, proxy, work);
    expect(id).toBe('A4H');
    expect(calls.map((c) => c.method)).toEqual([
      'adtLs/destinations/initializeService',
      'adtLs/destinations/create',
      'adtLs/destinations/ensureLoggedOn',
      'adtLs/mcp/setDestination',
    ]);
    // isolated store path under the work dir (never the global store)
    const init = calls[0].params as { destinationsStorePath: string };
    expect(init.destinationsStorePath.startsWith(work)).toBe(true);
    // create points adt-ls at the reverse proxy
    const create = calls[1].params as { properties: { systemUrl: string } };
    expect(create.properties.systemUrl).toBe('https://localhost:49999');
  });

  it('throws when logon does not reach connected', async () => {
    work = await fsp.mkdtemp(path.join(os.tmpdir(), 'arc1-engine-test-'));
    const { driver } = fakeDriver('disconnected');
    await expect(connectDestination(driver, target, proxy, work)).rejects.toThrow(/logon to A4H failed: disconnected/);
  });
});
