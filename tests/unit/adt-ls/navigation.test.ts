import { describe, expect, it, vi } from 'vitest';
import type { LspClient } from '../../../src/adt-ls/driver.js';
import { createNavigation } from '../../../src/adt-ls/navigation.js';

const AFF = 'abap:/repotree-v1/A4H/…/ZCL_X/zcl_x.clas.abap';
const SYMBOLS = [
  {
    name: 'ZCL_X',
    kind: 5,
    selectionRange: { start: { line: 1, character: 6 } },
    children: [{ name: 'RUN', kind: 6, selectionRange: { start: { line: 3, character: 12 } } }],
  },
];

function fakes(responses: Record<string, unknown> = {}) {
  const reqs: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notes: Array<{ method: string; params: Record<string, unknown> }> = [];
  const lsp = {
    sendRequest: vi.fn(async (method: string, params: Record<string, unknown>) => {
      reqs.push({ method, params });
      if (Object.hasOwn(responses, method)) {
        const r = responses[method];
        return typeof r === 'function' ? (r as (p: unknown) => unknown)(params) : r;
      }
      if (method === 'adtLs/fileSystem/readFile') return { content: 'CLASS zcl_x.\nENDCLASS.' };
      if (method === 'textDocument/documentSymbol') return SYMBOLS;
      return {};
    }),
    sendNotification: vi.fn(async (method: string, params: Record<string, unknown>) => {
      notes.push({ method, params });
    }),
  } as unknown as LspClient;
  const lifecycle = { resolveAffUri: vi.fn(async () => AFF) };
  const nav = createNavigation({ lsp, lifecycle });
  return { nav, reqs, notes, lsp, lifecycle };
}
const REF = { name: 'ZCL_X', objectType: 'CLAS/OC' };

describe('navigation document lifecycle', () => {
  it('documentSymbols opens, queries, and always closes the document', async () => {
    const f = fakes();
    await f.nav.documentSymbols(REF);
    expect(f.notes[0].method).toBe('textDocument/didOpen');
    expect((f.notes[0].params as { textDocument: { uri: string; languageId: string } }).textDocument).toMatchObject({
      uri: AFF,
      languageId: 'abap',
    });
    expect(f.reqs.some((r) => r.method === 'textDocument/documentSymbol')).toBe(true);
    expect(f.notes.at(-1)?.method).toBe('textDocument/didClose');
  });

  it('didClose still runs when the query throws', async () => {
    const f = fakes({
      'textDocument/diagnostic': () => {
        throw new Error('boom');
      },
    });
    await expect(f.nav.checkSyntax(REF)).rejects.toThrow();
    expect(f.notes.at(-1)?.method).toBe('textDocument/didClose');
  });

  it('checkSyntax queries textDocument/diagnostic', async () => {
    const f = fakes({ 'textDocument/diagnostic': { kind: 'full', items: [] } });
    expect(await f.nav.checkSyntax(REF)).toEqual({ kind: 'full', items: [] });
  });

  it('does not open/close the document when resolveAffUri throws (nothing to clean up)', async () => {
    const f = fakes();
    f.lifecycle.resolveAffUri.mockRejectedValueOnce(new Error('Object ZCL_X not found'));
    await expect(f.nav.documentSymbols(REF)).rejects.toThrow(/not found/);
    expect(f.notes).toHaveLength(0); // no didOpen, no didClose
  });

  it('serializes concurrent operations on the SAME object (per-URI lock)', async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const f = fakes({
      'textDocument/documentSymbol': () => {
        calls += 1;
        if (calls === 1)
          return new Promise((r) => {
            releaseFirst = () => r(SYMBOLS);
          });
        return SYMBOLS;
      },
    });
    const p1 = f.nav.documentSymbols(REF);
    const p2 = f.nav.documentSymbols(REF);
    await new Promise((r) => setTimeout(r, 10)); // let op1 open + block op2 on the lock
    expect(f.notes.filter((n) => n.method === 'textDocument/didOpen')).toHaveLength(1); // op2 waiting
    releaseFirst?.();
    await Promise.all([p1, p2]);
    // fully serialized: open → close → open → close (never open,open,close,close)
    expect(f.notes.map((n) => n.method)).toEqual([
      'textDocument/didOpen',
      'textDocument/didClose',
      'textDocument/didOpen',
      'textDocument/didClose',
    ]);
  });
});

describe('navigation position resolution', () => {
  it('trusts selectionRange.start for a method/attribute (character > 0 = the name token)', async () => {
    const f = fakes();
    await f.nav.goToDefinition(REF, { symbol: 'RUN' }); // RUN selectionRange.start = {3,12}, char>0
    const def = f.reqs.find((r) => r.method === 'textDocument/definition');
    expect(def?.params.position).toEqual({ line: 3, character: 12 });
  });
  it('points at the class NAME (not the keyword at col 0) via a word-boundary search', async () => {
    const f = fakes({
      'adtLs/fileSystem/readFile': { content: 'class ZCL_DEMO definition.\nendclass.' },
      'textDocument/documentSymbol': [
        { name: 'ZCL_DEMO', kind: 5, selectionRange: { start: { line: 0, character: 0 } } },
      ],
    });
    await f.nav.goToDefinition({ name: 'ZCL_DEMO', objectType: 'CLAS/OC' }, { symbol: 'ZCL_DEMO' });
    // "class ZCL_DEMO …" → name token starts at index 6 (NOT the `class` keyword at col 0)
    expect(f.reqs.find((r) => r.method === 'textDocument/definition')?.params.position).toEqual({
      line: 0,
      character: 6,
    });
  });
  it('class name search skips the leading `class` keyword (word boundary, no substring collision)', async () => {
    // selectionRange at col 0 + a name that does NOT collide; the `class` keyword must be skipped.
    const f = fakes({
      'adtLs/fileSystem/readFile': { content: 'CLASS zcl_widget DEFINITION PUBLIC.' },
      'textDocument/documentSymbol': [
        { name: 'ZCL_WIDGET', kind: 5, selectionRange: { start: { line: 0, character: 0 } } },
      ],
    });
    await f.nav.goToDefinition({ name: 'ZCL_WIDGET', objectType: 'CLAS/OC' }, { symbol: 'ZCL_WIDGET' });
    expect(f.reqs.find((r) => r.method === 'textDocument/definition')?.params.position).toEqual({
      line: 0,
      character: 6,
    });
  });
  it('converts explicit 1-based line/character → 0-based LSP position', async () => {
    const f = fakes();
    await f.nav.goToDefinition(REF, { line: 5, character: 9 });
    expect(f.reqs.find((r) => r.method === 'textDocument/definition')?.params.position).toEqual({
      line: 4,
      character: 8,
    });
  });
  it('errors (listing symbols) when a symbol name is not found', async () => {
    const f = fakes();
    await expect(f.nav.goToDefinition(REF, { symbol: 'NOPE' })).rejects.toThrow(/not found.*ZCL_X.*RUN/s);
  });
  it('errors when neither symbol nor line+character is given', async () => {
    const f = fakes();
    await expect(f.nav.goToDefinition(REF, {})).rejects.toThrow(/Provide a `symbol`/);
  });
});

describe('navigation queries', () => {
  it('findReferences sends references with includeDeclaration context', async () => {
    const f = fakes({ 'textDocument/references': [{ uri: AFF }] });
    await f.nav.findReferences(REF, { symbol: 'RUN' }, { includeDeclaration: false });
    const r = f.reqs.find((x) => x.method === 'textDocument/references');
    expect(r?.params.context).toEqual({ includeDeclaration: false });
  });
  it('findReferences rejects with a clear message on timeout', async () => {
    const f = fakes({ 'textDocument/references': () => new Promise(() => {}) }); // never resolves
    await expect(f.nav.findReferences(REF, { symbol: 'RUN' }, { timeoutMs: 30 })).rejects.toThrow(
      /timed out.*heavily used/s,
    );
  });
  it('typeHierarchy prepares then fetches supertypes + subtypes', async () => {
    const item = { name: 'ZCL_X', kind: 5 };
    const f = fakes({
      'textDocument/prepareTypeHierarchy': [item],
      'typeHierarchy/supertypes': [{ name: 'ZCL_BASE' }],
      'typeHierarchy/subtypes': [{ name: 'ZCL_SUB' }],
    });
    const r = (await f.nav.typeHierarchy(REF, { symbol: 'ZCL_X' })) as Record<string, unknown>;
    expect(r.item).toEqual(item);
    expect(r.supertypes).toEqual([{ name: 'ZCL_BASE' }]);
    expect(r.subtypes).toEqual([{ name: 'ZCL_SUB' }]);
    expect(f.reqs.find((x) => x.method === 'typeHierarchy/supertypes')?.params).toEqual({ item });
  });
  it('typeHierarchy direction=subtypes skips supertypes', async () => {
    const f = fakes({ 'textDocument/prepareTypeHierarchy': [{ name: 'ZCL_X' }], 'typeHierarchy/subtypes': [] });
    await f.nav.typeHierarchy(REF, { symbol: 'ZCL_X' }, { direction: 'subtypes' });
    expect(f.reqs.some((x) => x.method === 'typeHierarchy/supertypes')).toBe(false);
    expect(f.reqs.some((x) => x.method === 'typeHierarchy/subtypes')).toBe(true);
  });
  it('typeHierarchy returns empty result when prepare yields nothing', async () => {
    const f = fakes({ 'textDocument/prepareTypeHierarchy': [] });
    expect(await f.nav.typeHierarchy(REF, { symbol: 'ZCL_X' })).toEqual({ item: null, supertypes: [], subtypes: [] });
  });
  it('completion caps items + reports the total', async () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ label: `K${i}` }));
    const f = fakes({ 'textDocument/completion': { isIncomplete: false, items } });
    const r = (await f.nav.completion(REF, { symbol: 'RUN' }, { maxItems: 10 })) as {
      total: number;
      items: unknown[];
    };
    expect(r.total).toBe(120);
    expect(r.items).toHaveLength(10);
  });
});

describe('navigation hover / documentHighlight (token-cache primed)', () => {
  const HOVER = { contents: { kind: 'markdown', value: 'METHOD run' }, range: {} };

  it('hover primes semanticTokens/full BEFORE querying hover, at the resolved position', async () => {
    const f = fakes({ 'textDocument/hover': HOVER });
    const r = await f.nav.hover(REF, { symbol: 'RUN' });
    expect(r).toEqual(HOVER);
    const order = f.reqs.map((x) => x.method);
    const prime = order.indexOf('textDocument/semanticTokens/full');
    const hover = order.indexOf('textDocument/hover');
    expect(prime).toBeGreaterThanOrEqual(0); // primed
    expect(prime).toBeLessThan(hover); // …before the hover query
    expect(f.reqs.find((x) => x.method === 'textDocument/hover')?.params.position).toEqual({ line: 3, character: 12 });
  });

  it('hover still queries when token priming fails (best-effort, swallowed)', async () => {
    const f = fakes({
      'textDocument/semanticTokens/full': () => {
        throw new Error('no tokens');
      },
      'textDocument/hover': HOVER,
    });
    expect(await f.nav.hover(REF, { symbol: 'RUN' })).toEqual(HOVER);
    expect(f.notes.at(-1)?.method).toBe('textDocument/didClose'); // doc still cleaned up
  });

  it('documentHighlight primes then queries textDocument/documentHighlight', async () => {
    const highlights = [{ range: {}, kind: 1 }];
    const f = fakes({ 'textDocument/documentHighlight': highlights });
    expect(await f.nav.documentHighlight(REF, { symbol: 'RUN' })).toEqual(highlights);
    const order = f.reqs.map((x) => x.method);
    expect(order.indexOf('textDocument/semanticTokens/full')).toBeLessThan(
      order.indexOf('textDocument/documentHighlight'),
    );
  });

  it('goToDeclaration queries textDocument/declaration WITHOUT priming tokens', async () => {
    const f = fakes({ 'textDocument/declaration': [{ targetUri: AFF }] });
    await f.nav.goToDeclaration(REF, { symbol: 'RUN' });
    expect(f.reqs.some((x) => x.method === 'textDocument/semanticTokens/full')).toBe(false);
    expect(f.reqs.find((x) => x.method === 'textDocument/declaration')?.params.position).toEqual({
      line: 3,
      character: 12,
    });
  });
});
