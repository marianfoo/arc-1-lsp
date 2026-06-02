import { describe, expect, it, vi } from 'vitest';
import type { LspClient } from '../../../src/adt-ls/driver.js';
import { createQuality } from '../../../src/adt-ls/quality.js';

const AFF = 'abap:/repotree-v1/A4H/…/ZCL_X/zcl_x.clas.abap';

function fakes(responses: Record<string, unknown> = {}) {
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
  const lifecycle = { resolveAffUri: vi.fn(async () => AFF) };
  const quality = createQuality({ lsp, lifecycle });
  return { quality, reqs, lsp, lifecycle };
}
const REF = { name: 'ZCL_X', objectType: 'CLAS/OC' };

describe('quality — ATC', () => {
  it('runAtc resolves the AFF uri and runs adtLs/atc/runCheck with the system default (empty) variant', async () => {
    const findings = { atcRunCheckResults: [{ checkId: 'X', priority: 2, message: 'm' }] };
    const f = fakes({ 'adtLs/atc/runCheck': findings });
    expect(await f.quality.runAtc(REF)).toEqual(findings);
    expect(f.lifecycle.resolveAffUri).toHaveBeenCalledWith(REF);
    const r = f.reqs.find((x) => x.method === 'adtLs/atc/runCheck');
    expect(r?.params).toEqual({ objectUri: AFF, checkVariant: '' });
  });

  it('runAtc forwards an explicit checkVariant', async () => {
    const f = fakes({ 'adtLs/atc/runCheck': { atcRunCheckResults: [] } });
    await f.quality.runAtc(REF, { checkVariant: 'ABAP_CLOUD_READINESS' });
    expect(f.reqs.find((x) => x.method === 'adtLs/atc/runCheck')?.params).toEqual({
      objectUri: AFF,
      checkVariant: 'ABAP_CLOUD_READINESS',
    });
  });

  it('runAtc times out (backend busy-polls) with an actionable message', async () => {
    const f = fakes({ 'adtLs/atc/runCheck': () => new Promise(() => {}) }); // never resolves
    await expect(f.quality.runAtc(REF, { timeoutMs: 30 })).rejects.toThrow(/run_atc timed out.*check variant/s);
  });

  it('listAtcVariants queries adtLs/atc/getCheckVariants with objectUri + query', async () => {
    const f = fakes({ 'adtLs/atc/getCheckVariants': { checkVariants: { DEFAULT: 'Default' } } });
    const r = (await f.quality.listAtcVariants(REF, { query: 'cloud' })) as { checkVariants: unknown };
    expect(r.checkVariants).toEqual({ DEFAULT: 'Default' });
    expect(f.reqs.find((x) => x.method === 'adtLs/atc/getCheckVariants')?.params).toEqual({
      objectUri: AFF,
      quickPickUserInput: 'cloud',
    });
  });

  it('listAtcVariants defaults the query to "*" (backend rejects an empty param value)', async () => {
    const f = fakes({ 'adtLs/atc/getCheckVariants': { checkVariants: {} } });
    await f.quality.listAtcVariants(REF); // no query
    expect(f.reqs.find((x) => x.method === 'adtLs/atc/getCheckVariants')?.params).toEqual({
      objectUri: AFF,
      quickPickUserInput: '*',
    });
    await f.quality.listAtcVariants(REF, { query: '   ' }); // blank → also "*"
    expect((f.reqs.at(-1)?.params as { quickPickUserInput: string }).quickPickUserInput).toBe('*');
  });
});

describe('quality — ABAP Unit coverage', () => {
  it('runs tests with measurement=COVERAGE, then fetches coverage from the returned handle', async () => {
    const coverageParams = { destinationId: 'A4H', coverageMeasurementUri: '/m/1', forObjects: [AFF] };
    const coverage = [{ name: 'ZCL_X', coverageNumbers: { statement: { covered: 8, total: 10 } } }];
    const f = fakes({
      'adtLs/abapUnit/runTests': { status: { ok: true }, result: { items: [] }, coverageParams },
      'adtLs/coverage/getCoverage': { coverage },
    });
    const r = (await f.quality.runUnitTestsWithCoverage(REF)) as { coverage: unknown; status: unknown };
    expect(r.coverage).toEqual(coverage);
    expect(r.status).toEqual({ ok: true });
    // runTests carried measurement=COVERAGE for the resolved lsUri…
    expect(f.reqs.find((x) => x.method === 'adtLs/abapUnit/runTests')?.params).toEqual({
      lsUris: [AFF],
      measurement: 'COVERAGE',
    });
    // …and getCoverage was fed the exact coverageParams handle from the run.
    expect(f.reqs.find((x) => x.method === 'adtLs/coverage/getCoverage')?.params).toEqual(coverageParams);
  });

  it('returns coverage:null and skips getCoverage when the object has no tests (no coverageParams)', async () => {
    const f = fakes({ 'adtLs/abapUnit/runTests': { status: { ok: true }, result: { items: [] } } });
    const r = (await f.quality.runUnitTestsWithCoverage(REF)) as { coverage: unknown };
    expect(r.coverage).toBeNull();
    expect(f.reqs.some((x) => x.method === 'adtLs/coverage/getCoverage')).toBe(false);
  });
});
