import { describe, expect, it, vi } from 'vitest';
import type { LspClient } from '../../../src/adt-ls/driver.js';
import { createServices } from '../../../src/adt-ls/services.js';
import type { WriteSafety } from '../../../src/server/safety.js';

const AFF = 'abap:/repotree-v1/A4H/…/Z_X/z_x.clas.abap';
const SRVB = 'abap:/repotree-v1/A4H/…/Z_BIND/z_bind.srvb.json';

function fakes(responses: Record<string, unknown> = {}, safety?: Partial<WriteSafety>) {
  const reqs: Array<{ method: string; params: unknown }> = [];
  const lsp = {
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      reqs.push({ method, params });
      if (Object.hasOwn(responses, method)) {
        const r = responses[method];
        return typeof r === 'function' ? (r as (p: unknown) => unknown)(params) : r;
      }
      return {};
    }),
    sendNotification: vi.fn(async () => {}),
  } as unknown as LspClient;
  const lifecycle = {
    resolveAffUri: vi.fn(async (ref: { objectType: string }) => (ref.objectType === 'SRVB/SVB' ? SRVB : AFF)),
  };
  const fullSafety: WriteSafety = { allowWrites: true, allowTransportWrites: false, allowedPackages: ['*'], ...safety };
  const services = createServices({ lsp, lifecycle, safety: fullSafety });
  return { services, reqs, lsp, lifecycle };
}

describe('services — run application', () => {
  it('runApplication sends the resolved AFF uri as a raw string param and returns the output', async () => {
    const f = fakes({ 'adtLs/run/runApplication': 'Hello from ABAP\n42' });
    const r = (await f.services.runApplication({ name: 'Z_X', objectType: 'CLAS/OC' })) as { output: string };
    expect(r.output).toBe('Hello from ABAP\n42');
    const req = f.reqs.find((x) => x.method === 'adtLs/run/runApplication');
    expect(req?.params).toBe(AFF); // raw string, not wrapped in an object
  });

  it('runApplication coerces a null/empty result to ""', async () => {
    const f = fakes({ 'adtLs/run/runApplication': null });
    const r = (await f.services.runApplication({ name: 'Z_X', objectType: 'CLAS/OC' })) as { output: string };
    expect(r.output).toBe('');
  });
});

describe('services — service binding', () => {
  it('serviceBindingDetails queries the native srvb segment with the binding lsUri', async () => {
    const details = { serviceBindingName: 'Z_BIND', odataversion: 'V4', services: [] };
    const f = fakes({ 'adtLs/businessservice/srvb/getServiceBindingDetails': details });
    expect(await f.services.serviceBindingDetails({ name: 'Z_BIND', objectType: 'SRVB/SVB' })).toEqual(details);
    // SFS warm-up: readFile the binding first (else the segment errors "Unsupported Object Type")…
    const order = f.reqs.map((x) => x.method);
    expect(order.indexOf('adtLs/fileSystem/readFile')).toBeLessThan(
      order.indexOf('adtLs/businessservice/srvb/getServiceBindingDetails'),
    );
    expect(f.reqs.find((x) => x.method === 'adtLs/fileSystem/readFile')?.params).toEqual({ uri: SRVB });
    // …then the segment query carries the binding lsUri.
    expect(f.reqs.find((x) => x.method === 'adtLs/businessservice/srvb/getServiceBindingDetails')?.params).toEqual({
      lsUri: SRVB,
    });
  });

  it('publishServiceBinding sends publishandUnpublishAction with the binding lsUri', async () => {
    const result = { isExecuted: true, isPublishSuccess: true, statusMessage: 'Published' };
    const f = fakes({ 'adtLs/businessservice/srvb/publishandUnpublishAction': result });
    expect(await f.services.publishServiceBinding({ name: 'Z_BIND', objectType: 'SRVB/SVB' })).toEqual(result);
    expect(f.reqs.find((x) => x.method === 'adtLs/businessservice/srvb/publishandUnpublishAction')?.params).toEqual({
      lsUri: SRVB,
    });
  });

  it('publishServiceBinding is blocked in read-only mode (allowWrites=false)', async () => {
    const f = fakes({}, { allowWrites: false });
    await expect(f.services.publishServiceBinding({ name: 'Z_BIND', objectType: 'SRVB/SVB' })).rejects.toThrow(
      /Writes are disabled/,
    );
    // and it must NOT have reached the LSP
    expect(f.reqs.some((x) => x.method.includes('publishandUnpublish'))).toBe(false);
  });
});
