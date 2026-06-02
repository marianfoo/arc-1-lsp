/**
 * Read-only repository queries over LSP. Verified headless against a4h.
 * (`read_source` is NOT here — adt-ls's `fileSystem/readFile` needs VS Code's
 * workspace/tree model and returns empty headless; see `docs/adt-ls-tool-surface.md`.)
 */
import type { LspRequester } from './driver.js';

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
 *
 * `retryOnEmptyMs` (default 0 = off) smooths the cold repository index: the first
 * query after a fresh connection often returns [] while adt-ls warms up. When set,
 * an empty result is retried once after that delay. A genuinely-absent object pays
 * one extra delay — an acceptable trade for not surfacing a spurious "not found".
 */
export async function quickSearch(
  driver: LspRequester,
  params: { destination: string; pattern: string; maxResults?: number; types?: string[] },
  opts: { retryOnEmptyMs?: number } = {},
): Promise<QuickSearchResult> {
  const run = () =>
    driver.sendRequest<QuickSearchResult>('adtLs/repository/quickSearch', {
      destination: params.destination,
      pattern: params.pattern,
      maxResults: params.maxResults ?? 50,
      types: params.types ?? [],
    });
  let r = await run();
  if ((r.references?.length ?? 0) === 0 && (opts.retryOnEmptyMs ?? 0) > 0) {
    await new Promise((resolve) => setTimeout(resolve, opts.retryOnEmptyMs));
    r = await run();
  }
  return r;
}

/** List inactive (draft) objects on a destination. Uses `destinationId`. */
export function getInactiveObjects(driver: LspRequester, destinationId: string): Promise<unknown[]> {
  return driver.sendRequest<unknown[]>('adtLs/activation/getInactiveObjects', { destinationId });
}

/**
 * Resolve an ADT path (from a search result) to the canonical repotree AFF URI
 * that readFile/writeFile/activate need. Param key MUST be `adtUri` (verified).
 */
export async function getLsUri(driver: LspRequester, destination: string, adtUri: string): Promise<string> {
  const r = await driver.sendRequest<{ uri?: string }>('adtLs/repository/getLsUri', { destination, adtUri });
  if (!r.uri) throw new Error(`getLsUri returned no uri for ${adtUri}`);
  return r.uri;
}

/** Read an AFF file's content (the object source) by its repotree URI. */
export async function readFile(driver: LspRequester, uri: string): Promise<string> {
  const r = await driver.sendRequest<{ content?: string }>('adtLs/fileSystem/readFile', { uri });
  return r.content ?? '';
}

/** Write an AFF file (update source). `content` must be plain multi-line text. */
export function writeFile(driver: LspRequester, uri: string, content: string): Promise<unknown> {
  return driver.sendRequest('adtLs/fileSystem/writeFile', { uri, content });
}

/** Delete an object via its AFF metadata (`.json`) URI. */
export function deleteFile(driver: LspRequester, uri: string): Promise<unknown> {
  return driver.sendRequest('adtLs/fileSystem/delete', { uri });
}

/** adt-ls returns this placeholder (not source) for object types it can't serve headless. */
export function isUnsupportedPlaceholder(content: string): boolean {
  return /not supported in ADT in VS Code/i.test(content);
}

/** Swap a class main-source AFF URI to one of its include files (CCDEF/CCIMP/…). */
export function includeAffUri(mainAffUri: string, include: string): string {
  // …/zcl_x.clas.abap → …/zcl_x.clas.<include>.abap
  return mainAffUri.replace(/\.clas\.abap$/, `.clas.${include}.abap`);
}

/** Derive the AFF metadata (`.json`) URI from a main-source AFF URI (final ext → json). */
export function metadataAffUri(mainAffUri: string): string {
  return mainAffUri.replace(/\.[^./]+$/, '.json');
}

/** A repository/system user. */
export interface UserRef {
  id: string;
  text?: string;
}

/** List system users (e.g. for ownership/transport context). Uses `destination`. */
export async function getUsers(driver: LspRequester, destination: string): Promise<UserRef[]> {
  const r = await driver.sendRequest<{ users?: UserRef[] }>('adtLs/repository/getUsers', { destination });
  return r.users ?? [];
}
