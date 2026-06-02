/**
 * Quality & test capabilities over adt-ls's custom LSP segments — ATC static
 * analysis (`adtLs/atc`) and ABAP Unit code coverage (`adtLs/abapUnit` +
 * `adtLs/coverage`). All READS (non-mutating). Each resolves the object to its
 * repotree AFF URI via lifecycle.resolveAffUri (the `objectUri`/`lsUri` these
 * segments expect). See docs/research/adt-ls-capability-map.md §4b.
 */
import type { LspClient } from './driver.js';
import type { Lifecycle, ObjectRef } from './lifecycle.js';

export interface QualityDeps {
  lsp: LspClient;
  /** Reused for name → repotree AFF URI (carries the destination). */
  lifecycle: Pick<Lifecycle, 'resolveAffUri'>;
}

/** Race a request against a timeout (clears the timer); the adt-ls ATC/unit backends
 * busy-poll server-side, so a hung run must not hang the tool. */
async function withTimeout<T>(label: string, p: Promise<T>, timeoutMs: number, hint: string): Promise<T> {
  p.catch(() => {}); // no unhandled rejection if the timeout wins the race
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms — ${hint}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createQuality(deps: QualityDeps) {
  const { lsp, lifecycle } = deps;

  return {
    /**
     * List the ATC check variants configured on the system (name → description).
     * An empty map means the backend has no variants configured — `runAtc` then
     * falls back to the system default variant. `query` filters the picker list.
     */
    async listAtcVariants(ref: ObjectRef, opts: { query?: string } = {}): Promise<unknown> {
      const objectUri = await lifecycle.resolveAffUri(ref);
      // The backend NamedItemService rejects an empty query param ("Parameter value
      // must not be empty" — UriBuilder.addQueryParameter), so default to the "*"
      // wildcard (match all variants) when no filter is given. Verified live on a4h.
      const query = opts.query?.trim() ? opts.query : '*';
      return lsp.sendRequest('adtLs/atc/getCheckVariants', { objectUri, quickPickUserInput: query });
    },

    /**
     * Run ABAP Test Cockpit (static analysis) on an object. An empty `checkVariant`
     * uses the backend's configured **system default** variant — so callers normally
     * omit it. Findings: `{lineNumber, priority, message, checkId, checkTitle, …}`
     * (report-only; no quickfix). The backend busy-polls until the run finishes, so
     * the call is timeout-guarded.
     */
    async runAtc(ref: ObjectRef, opts: { checkVariant?: string; timeoutMs?: number } = {}): Promise<unknown> {
      const objectUri = await lifecycle.resolveAffUri(ref);
      return withTimeout(
        'run_atc',
        lsp.sendRequest('adtLs/atc/runCheck', { objectUri, checkVariant: opts.checkVariant ?? '' }),
        opts.timeoutMs ?? 60_000,
        'the ATC run did not finish — the backend may be slow or have no ATC check variant configured (see list_atc_variants).',
      );
    },

    /**
     * Run ABAP Unit tests WITH code coverage. Two-phase: `abapUnit/runTests` with
     * `measurement:"COVERAGE"` mints a coverage handle (`coverageParams`), then
     * `coverage/getCoverage` aggregates statement/branch/procedure counts. Returns
     * `{status, result, coverage}` — `coverage` is null when the object has no tests
     * (so no measurement was produced).
     */
    async runUnitTestsWithCoverage(ref: ObjectRef, opts: { timeoutMs?: number } = {}): Promise<unknown> {
      const lsUri = await lifecycle.resolveAffUri(ref);
      const run = (await withTimeout(
        'run_unit_tests_with_coverage',
        lsp.sendRequest('adtLs/abapUnit/runTests', { lsUris: [lsUri], measurement: 'COVERAGE' }),
        opts.timeoutMs ?? 120_000,
        'the unit-test run did not finish.',
      )) as { result?: unknown; status?: unknown; coverageParams?: unknown };
      let coverage: unknown = null;
      if (run?.coverageParams) {
        const cov = (await lsp.sendRequest('adtLs/coverage/getCoverage', run.coverageParams)) as {
          coverage?: unknown;
        } | null;
        coverage = cov?.coverage ?? cov ?? null;
      }
      return { status: run?.status ?? null, result: run?.result ?? null, coverage };
    },
  };
}

export type Quality = ReturnType<typeof createQuality>;
