/**
 * Open a URL in the user's default browser — used for interactive SSO logon (the adt-ls
 * `requestBrowserBasedLogon` flow). Local/desktop only: there is no browser on a headless
 * server, so SSO is for `npm run dev` on a developer machine, not remote/BTP deployments.
 *
 * No dependency — a small per-OS `spawn`. The command builder is pure so it's unit-testable.
 */
import { spawn } from 'node:child_process';
import { logger } from './logger.js';

/** The OS-specific command to open `url` in the default browser. Pure (testable). */
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  // NOT `cmd /c start <url>` — cmd re-parses the tail under its own grammar, so a URL with
  // `&` query params (every reentrance/SAML URL has them) truncates at the first `&` (and is
  // an arg-injection surface). `rundll32 url.dll,FileProtocolHandler` takes the URL as a
  // true argv argument with no shell re-parse → safe and `&`-correct.
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Best-effort: launch the default browser at `url`, detached. Never throws — a failure to
 * open is logged (the user can still paste the URL manually). The URL is printed so a
 * remote/headless session, or a failed launch, still lets the user complete sign-in.
 */
export function openInBrowser(url: string): void {
  logger.info(`SSO: opening browser for sign-in. If it doesn't open, visit:\n${url}`);
  const { cmd, args } = browserOpenCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (e) =>
      logger.warn(`SSO: could not launch browser (${cmd}): ${e.message}. Open the URL above manually.`),
    );
    child.unref();
  } catch (e) {
    logger.warn(
      `SSO: could not launch browser: ${e instanceof Error ? e.message : String(e)}. Open the URL above manually.`,
    );
  }
}
