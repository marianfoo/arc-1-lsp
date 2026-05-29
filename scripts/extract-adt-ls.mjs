#!/usr/bin/env node
/**
 * Extract the linux adt-ls from a downloaded VSIX into vendor/adt-ls/ for the
 * container build. arc-1-lsp never commits the binary (vendor/adt-ls is
 * gitignored) — the licensed admin stages it at build time.
 *
 * Usage: node scripts/extract-adt-ls.mjs [vendor/adt-vscode-linux-x64.vsix]
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const vsix = path.resolve(process.argv[2] ?? path.join(repoRoot, 'vendor', 'adt-vscode-linux-x64.vsix'));
const vendorAdtLs = path.join(repoRoot, 'vendor', 'adt-ls');
const tmp = path.join(repoRoot, 'vendor', '.vsix-extract');

if (!existsSync(vsix)) {
  console.error(`VSIX not found: ${vsix}\nDownload the SAPSE.adt-vscode linux-x64 VSIX into vendor/ first.`);
  process.exit(1);
}

rmSync(tmp, { recursive: true, force: true });
rmSync(vendorAdtLs, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// Unzip only the adt-ls subtree.
execFileSync('unzip', ['-qo', vsix, 'extension/adt-ls/*', '-d', tmp], { stdio: 'inherit' });

mkdirSync(path.dirname(vendorAdtLs), { recursive: true });
execFileSync('cp', ['-R', path.join(tmp, 'extension', 'adt-ls'), vendorAdtLs]);
rmSync(tmp, { recursive: true, force: true });

const bin = path.join(vendorAdtLs, 'linux', 'gtk', 'x86_64', 'adt-ls');
if (!existsSync(bin)) {
  console.error(`Expected linux binary missing after extract: ${bin}`);
  process.exit(1);
}
chmodSync(bin, 0o755);
console.log(`adt-ls extracted → ${bin}`);
