/**
 * Read-only repository queries over LSP. Verified headless against a4h.
 * (`read_source` is NOT here — adt-ls's `fileSystem/readFile` needs VS Code's
 * workspace/tree model and returns empty headless; see `docs/adt-ls-tool-surface.md`.)
 */
import type { AdtLsDriver } from './driver.js';

/** A repository object hit from quickSearch. `uri` is the ADT object path. */
export interface SearchReference {
  name: string;
  description?: string;
  type?: string;
  uri?: string;
}

export interface QuickSearchResult {
  references: SearchReference[];
  message?: { label?: string; detail?: string; severity?: number };
}

/**
 * Repository object search (SAPSearch). NOTE the exact param names adt-ls wants:
 * the search string is `pattern` (NOT `query`) and `destination` (NOT
 * `destinationId`); `types` filters by object type (empty = all).
 */
export function quickSearch(
  driver: AdtLsDriver,
  params: { destination: string; pattern: string; maxResults?: number; types?: string[] },
): Promise<QuickSearchResult> {
  return driver.sendRequest<QuickSearchResult>('adtLs/repository/quickSearch', {
    destination: params.destination,
    pattern: params.pattern,
    maxResults: params.maxResults ?? 50,
    types: params.types ?? [],
  });
}

/** List inactive (draft) objects on a destination. Uses `destinationId`. */
export function getInactiveObjects(driver: AdtLsDriver, destinationId: string): Promise<unknown[]> {
  return driver.sendRequest<unknown[]>('adtLs/activation/getInactiveObjects', { destinationId });
}
