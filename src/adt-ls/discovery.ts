/**
 * Locate a developer-provided `adt-ls` binary. arc-1-lsp never ships or
 * redistributes adt-ls (SAP Developer License) — it discovers one the developer
 * already installed.
 *
 * Resolution order:
 *   1. explicit path (opts.explicitPath / ARC1_ADT_LS_PATH)
 *   2. vendor/adt-ls/ in the repo (build-time injection for containers)
 *   3. newest installed `sapse.adt-vscode-*` VS Code extension
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Platform/arch-specific sub-path under an `adt-ls/` root. */
export function platformSubPath(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const a = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  switch (platform) {
    case 'darwin':
      return ['macosx', 'cocoa', a, 'Adt-ls.app', 'Contents', 'MacOS', 'adt-ls'];
    case 'linux':
      return ['linux', 'gtk', a, 'adt-ls'];
    case 'win32':
      return ['win32', 'win32', a, 'adt-lsc.exe'];
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export interface DiscoverOptions {
  explicitPath?: string;
  repoRoot?: string;
  extensionsDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export function resolveAdtLsPath(opts: DiscoverOptions = {}): string {
  const tried: string[] = [];
  const sub = platformSubPath(opts.platform, opts.arch);

  const explicit = opts.explicitPath ?? process.env.ARC1_ADT_LS_PATH;
  if (explicit) {
    tried.push(explicit);
    if (fs.existsSync(explicit)) return explicit;
  }

  const repoRoot = opts.repoRoot ?? process.cwd();
  const vendor = path.join(repoRoot, 'vendor', 'adt-ls', ...sub);
  tried.push(vendor);
  if (fs.existsSync(vendor)) return vendor;

  const extDir = opts.extensionsDir ?? path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extDir)) {
    const candidates = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith('sapse.adt-vscode-'))
      .sort()
      .reverse();
    for (const c of candidates) {
      const p = path.join(extDir, c, 'adt-ls', ...sub);
      tried.push(p);
      if (fs.existsSync(p)) return p;
    }
  }

  const triedList = tried.map((t) => `  - ${t}`).join('\n');
  throw new Error(
    `adt-ls binary not found. Set ARC1_ADT_LS_PATH, drop it in vendor/adt-ls/, or install the 'sapse.adt-vscode' extension. Tried:\n${triedList}`,
  );
}
