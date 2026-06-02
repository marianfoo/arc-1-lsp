/**
 * LSP code-intelligence (the SECOND channel — adt-ls is a language server). Thin
 * proxies over standard `textDocument/*` methods: outline, definition, where-used,
 * type hierarchy, syntax check, completion. All READS (ungated).
 *
 * Per call: resolve name → repotree AFF URI (lifecycle.resolveAffUri) → readFile →
 * `textDocument/didOpen` (NOTIFICATION) → query → `didClose`. The earlier
 * "navigation hangs" was sending didOpen as a request — see docs/adt-ls-reference.md §9.
 */
import type { LspClient } from './driver.js';
import type { Lifecycle, ObjectRef } from './lifecycle.js';
import { readFile } from './repository.js';

/** Where to point a position-based query: a declared symbol name, OR an explicit
 * 1-based line+character (editor convention; converted to LSP 0-based). */
export interface Locator {
  symbol?: string;
  line?: number;
  character?: number;
}

interface Position {
  line: number;
  character: number;
}
interface DocumentSymbol {
  name: string;
  kind: number;
  selectionRange: { start: Position };
  children?: DocumentSymbol[];
}

export interface NavigationDeps {
  lsp: LspClient;
  /** Reused for name → repotree AFF URI (carries the destination). */
  lifecycle: Pick<Lifecycle, 'resolveAffUri'>;
}

export function createNavigation(deps: NavigationDeps) {
  const { lsp, lifecycle } = deps;

  // Per-URI serialization: didOpen/didClose share ONE LSP connection, so two
  // concurrent ops on the SAME object would duplicate-open and let the first's
  // didClose pull the document out from under the second's in-flight query.
  // Serialize per URI (different objects still run in parallel).
  const tails = new Map<string, Promise<void>>();
  function runExclusive<T>(uri: string, op: () => Promise<T>): Promise<T> {
    const prev = tails.get(uri) ?? Promise.resolve();
    const run = prev.then(op, op); // run after any prior op on this URI settles
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(uri, tail);
    tail.then(() => {
      if (tails.get(uri) === tail) tails.delete(uri);
    });
    return run;
  }

  /** Open the object's document, run fn (with its source), always didClose. */
  async function withOpenDocument<T>(ref: ObjectRef, fn: (uri: string, content: string) => Promise<T>): Promise<T> {
    const uri = await lifecycle.resolveAffUri(ref);
    return runExclusive(uri, async () => {
      const text = await readFile(lsp, uri);
      await lsp.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'abap', version: 1, text },
      });
      try {
        return await fn(uri, text);
      } finally {
        await lsp.sendNotification('textDocument/didClose', { textDocument: { uri } }).catch(() => {});
      }
    });
  }

  function findSymbol(symbols: DocumentSymbol[], name: string): DocumentSymbol | undefined {
    const lower = name.toLowerCase();
    for (const s of symbols) {
      if (s.name?.toLowerCase() === lower) return s;
      const c = s.children ? findSymbol(s.children, name) : undefined;
      if (c) return c;
    }
    return undefined;
  }
  function symbolNames(symbols: DocumentSymbol[]): string[] {
    return symbols.flatMap((s) => [s.name, ...(s.children ? symbolNames(s.children) : [])]);
  }

  /**
   * Point at the symbol's NAME token. adt-ls's `selectionRange` for a class/
   * interface spans the whole body and starts at the line's column 0 (the
   * keyword), which breaks position-based queries (e.g. type hierarchy returns
   * []). So locate the name within its declaration line; fall back to
   * selectionRange.start (correct for methods/attributes).
   */
  function positionOfSymbol(content: string, hit: DocumentSymbol): Position {
    const start = hit.selectionRange.start;
    // Methods/attributes: selectionRange.start IS the name token — trust it.
    if (start.character > 0) return start;
    // Class/interface: start is column 0 (the keyword); find the name on that line
    // with a word boundary so a keyword/substring (DATA, METHODS, …) can't collide.
    const lineText = content.split('\n')[start.line] ?? '';
    const escaped = hit.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`\\b${escaped}\\b`, 'i').exec(lineText);
    return m ? { line: start.line, character: m.index } : start;
  }

  /**
   * Prime the ABAP token cache so hover/documentHighlight pass the backend gate.
   * adt-ls's `AbapLsHoverService`/`AbapLsDocumentHighlightService` short-circuit to
   * null/[] at `AbapTokenFilterService.shouldCallBackend`, which requires the token
   * under the cursor to be in `AbapDocumentTokenCache` — and that cache is populated
   * ONLY as a side-effect of `textDocument/semanticTokens/full` (at the same document
   * version). Without this, ABAP hover is unconditionally null. Best-effort: errors are
   * swallowed (DDLS/JSON hover parse inline and don't need priming; the query just
   * degrades to its un-primed result). See docs/research/adt-ls-capability-map.md §3a.
   */
  async function primeTokens(uri: string): Promise<void> {
    await lsp.sendRequest('textDocument/semanticTokens/full', { textDocument: { uri } }).catch(() => {});
  }

  /** Resolve a locator → 0-based LSP position. Doc must already be open (symbol lookup). */
  async function resolvePosition(uri: string, content: string, locator: Locator): Promise<Position> {
    if (locator.line !== undefined && locator.character !== undefined) {
      return { line: Math.max(0, locator.line - 1), character: Math.max(0, locator.character - 1) };
    }
    if (locator.symbol) {
      const symbols =
        (await lsp.sendRequest<DocumentSymbol[]>('textDocument/documentSymbol', { textDocument: { uri } })) ?? [];
      const hit = findSymbol(symbols, locator.symbol);
      if (!hit) {
        throw new Error(
          `Symbol "${locator.symbol}" not found. Declared symbols: ${symbolNames(symbols).slice(0, 40).join(', ') || '(none)'}`,
        );
      }
      return positionOfSymbol(content, hit);
    }
    throw new Error('Provide a `symbol` name or explicit `line` + `character` (1-based).');
  }

  return {
    /** Object outline (LSP DocumentSymbol[] — kinds + ranges + children). */
    documentSymbols(ref: ObjectRef): Promise<unknown> {
      return withOpenDocument(ref, (uri) => lsp.sendRequest('textDocument/documentSymbol', { textDocument: { uri } }));
    },

    /** ABAP syntax check WITHOUT activating (pull diagnostics). */
    checkSyntax(ref: ObjectRef): Promise<unknown> {
      return withOpenDocument(ref, (uri) => lsp.sendRequest('textDocument/diagnostic', { textDocument: { uri } }));
    },

    /** Jump to a symbol's definition (LocationLink[]). */
    goToDefinition(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/definition', { textDocument: { uri }, position });
      });
    },

    /** Jump to a symbol's declaration/signature (LocationLink[]). For ABAP this is the
     * DEFINITION block (vs goToDefinition → the IMPLEMENTATION). No token-cache priming
     * needed — navigation doesn't use the hover/highlight backend gate. */
    goToDeclaration(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/declaration', { textDocument: { uri }, position });
      });
    },

    /** Hover info at a position — for ABAP a full signature + ABAP-Doc short text
     * (rendered markdown), for CDS/DDLS the element info. Primes the token cache first
     * (the ABAP backend gate); returns null when there's no element under the cursor. */
    hover(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        await primeTokens(uri);
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/hover', { textDocument: { uri }, position });
      });
    },

    /** Occurrences of the symbol at a position within the document (DocumentHighlight[]
     * — read/write/text kinds). Same token-cache gate as hover (primed first). */
    documentHighlight(ref: ObjectRef, locator: Locator): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        await primeTokens(uri);
        const position = await resolvePosition(uri, content, locator);
        return lsp.sendRequest('textDocument/documentHighlight', { textDocument: { uri }, position });
      });
    },

    /** Where-used (Location[]). Timeout-guarded: heavily-used global symbols can hang. */
    findReferences(
      ref: ObjectRef,
      locator: Locator,
      opts: { includeDeclaration?: boolean; timeoutMs?: number } = {},
    ): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        const timeoutMs = opts.timeoutMs ?? 20_000;
        const narrowHint =
          'the symbol is likely too heavily used (e.g. a global class/method); narrow to a local or less-referenced symbol.';
        const req = lsp.sendRequest('textDocument/references', {
          textDocument: { uri },
          position,
          context: { includeDeclaration: opts.includeDeclaration ?? true },
        });
        req.catch(() => {}); // avoid an unhandled rejection if the timeout already won the race
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            req,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`find_references timed out after ${timeoutMs}ms — ${narrowHint}`)),
                timeoutMs,
              );
            }),
          ]);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // adt-ls returns "Internal error" (not a hang) for some heavily-used symbols.
          if (/internal error/i.test(msg)) throw new Error(`find_references failed (${msg}) — ${narrowHint}`);
          throw e;
        } finally {
          if (timer) clearTimeout(timer);
        }
      });
    },

    /** Inheritance / implementation tree (prepareTypeHierarchy → super/sub). */
    typeHierarchy(
      ref: ObjectRef,
      locator: Locator,
      opts: { direction?: 'supertypes' | 'subtypes' | 'both' } = {},
    ): Promise<unknown> {
      const direction = opts.direction ?? 'both';
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        const items =
          (await lsp.sendRequest<unknown[]>('textDocument/prepareTypeHierarchy', {
            textDocument: { uri },
            position,
          })) ?? [];
        if (!Array.isArray(items) || !items[0]) return { item: null, supertypes: [], subtypes: [] };
        const item = items[0];
        const result: { item: unknown; supertypes?: unknown; subtypes?: unknown } = { item };
        if (direction === 'supertypes' || direction === 'both') {
          result.supertypes = await lsp.sendRequest('typeHierarchy/supertypes', { item });
        }
        if (direction === 'subtypes' || direction === 'both') {
          result.subtypes = await lsp.sendRequest('typeHierarchy/subtypes', { item });
        }
        return result;
      });
    },

    /** Code completion at a position (capped — completion lists are huge). */
    completion(ref: ObjectRef, locator: Locator, opts: { maxItems?: number } = {}): Promise<unknown> {
      return withOpenDocument(ref, async (uri, content) => {
        const position = await resolvePosition(uri, content, locator);
        const res = await lsp.sendRequest<{ items?: unknown[]; isIncomplete?: boolean } | unknown[]>(
          'textDocument/completion',
          { textDocument: { uri }, position },
        );
        const items = Array.isArray(res) ? res : (res?.items ?? []);
        const isIncomplete = Array.isArray(res) ? undefined : res?.isIncomplete;
        return { isIncomplete, total: items.length, items: items.slice(0, opts.maxItems ?? 50) };
      });
    },
  };
}

export type Navigation = ReturnType<typeof createNavigation>;
