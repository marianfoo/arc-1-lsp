/**
 * Single source of truth for the arc-1-lsp version (bumped by release-please via
 * the marker below — keep the literal on one line) and the adt-ls release this
 * build was verified against.
 */
export const VERSION = '0.2.1'; // x-release-please-version

/**
 * The `sapse.adt-vscode` adt-ls build arc-1-lsp's reverse-engineered `adtLs/*`
 * protocol was verified against. The private protocol can change between
 * releases (see docs/assumptions-and-future-changes.md §6); a mismatch is a
 * soft warning, not an error.
 */
export const EXPECTED_ADT_LS_VERSION = '1.0.0.202605281240';

/**
 * Warn (once) when the connected adt-ls reports a version other than the one we
 * verified against. Pure (takes the log sink) so it's trivially testable.
 */
export function warnOnAdtLsVersionMismatch(detected: string | undefined, warn: (msg: string) => void): void {
  if (!detected || detected === EXPECTED_ADT_LS_VERSION) return;
  warn(
    `adt-ls version ${detected} differs from the verified ${EXPECTED_ADT_LS_VERSION}; the private adtLs/* protocol may have changed — re-verify against docs/adt-ls-reference.md (see docs/assumptions-and-future-changes.md §6).`,
  );
}
