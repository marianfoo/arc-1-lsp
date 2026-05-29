/**
 * Minimal write-safety layer for arc-1-lsp's mutating tools. Read-only tools are
 * never gated. Mirrors the *spirit* of ARC-1's safety ceiling (allowWrites +
 * package allowlist) at a v1 scale — single tech-user, API-key edge.
 */
export interface WriteSafety {
  allowWrites: boolean;
  allowedPackages: string[];
}

/** Package allowlist match: `*` (any), exact, or `PREFIX*`. Case-insensitive. */
export function isPackageAllowed(allowed: string[], pkg: string): boolean {
  const p = pkg.toUpperCase();
  return allowed.some((raw) => {
    const a = raw.toUpperCase();
    if (a === '*') return true;
    if (a.endsWith('*')) return p.startsWith(a.slice(0, -1));
    return a === p;
  });
}

/**
 * Throw a clear error if a mutating action isn't permitted. `packageName` is
 * checked against the allowlist when supplied (e.g. on create).
 */
export function assertWriteAllowed(safety: WriteSafety, opts: { action: string; packageName?: string }): void {
  if (!safety.allowWrites) {
    throw new Error(`Writes are disabled (read-only mode). Set ARC1_ALLOW_WRITES=true to enable ${opts.action}.`);
  }
  if (opts.packageName && !isPackageAllowed(safety.allowedPackages, opts.packageName)) {
    throw new Error(
      `Package "${opts.packageName}" is not in the write allowlist [${safety.allowedPackages.join(', ')}]. Set ARC1_ALLOWED_PACKAGES to permit it.`,
    );
  }
}
