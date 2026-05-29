/**
 * Self-healing SAP session: detect adt-ls "logged off" failures and transparently
 * re-logon + retry once.
 *
 * Why this exists: adt-ls holds a SAP *security session* for the destination
 * after the reentrance-ticket logon. That session expires server-side (typically
 * on inactivity). When it does, the next ADT call fails with "Your user was
 * logged off" — and stays broken until the destination logs on again. Before this
 * module the only cure was restarting the whole instance (observed on CF).
 *
 * The cure is cheap: call `ensureLoggedOn` again. Our reentrance-ticket handler
 * stays registered on the driver for the process lifetime, so a fresh
 * `ensureLoggedOn` re-fires it and re-establishes the session via the exact path
 * proven at startup (ADR-0006). This module is the pure policy — detection +
 * single-retry orchestration + re-logon de-duplication — wired to the real
 * `ensureLoggedOn`/`setMcpDestination` in `engine.ts`.
 */

/**
 * Signatures of a lost SAP session. Deliberately specific (SAP's "logged off"
 * phrase, session-expiry variants, explicit HTTP 401) rather than broad — a false
 * positive would re-logon + retry a call that failed for an unrelated reason. A
 * normal ABAP syntax/validation error never matches.
 */
const LOGGED_OFF =
  /logged.?off|not logged on|logon (?:failed|required|denied|expired)|session\b[\w\s'"-]{0,24}?\b(?:expired|terminated|timed[- ]?out|invalid|no longer valid)\b|http[\s/]?401|401 unauthorized/i;

/** True when an error/message text indicates the SAP session is gone. */
export function isLoggedOffMessage(text: string): boolean {
  return LOGGED_OFF.test(text);
}

/**
 * True when a *federated* MCP tool result is an error caused by a lost session.
 * The federation client returns tool-level failures as `{isError:true, content}`
 * (it only throws on JSON-RPC transport errors), so result inspection — not just
 * catching throws — is required to catch a logged-off mid-tool.
 */
export function isLoggedOffFederatedResult(res: unknown): boolean {
  const r = res as { isError?: boolean; content?: Array<{ text?: string }> } | undefined;
  if (!r?.isError) return false;
  return isLoggedOffMessage((r.content ?? []).map((c) => c?.text ?? '').join(' '));
}

/**
 * Serialize re-logon. A session loss fails every outstanding call at once; without
 * this they would each kick off their own `ensureLoggedOn`. Concurrent callers
 * share one in-flight attempt; once it settles the next loss starts a fresh one.
 */
export function makeRelogon(doRelogon: () => Promise<boolean>): () => Promise<boolean> {
  let inFlight: Promise<boolean> | undefined;
  return () => {
    if (!inFlight) {
      inFlight = doRelogon().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

/**
 * Wrap a call so a lost-session failure triggers a single re-logon + retry.
 * Detects loss two ways — a thrown error (LSP / JSON-RPC) or a federated result
 * flagged `isError` with a logged-off message (pass `loggedOffInResult`). Retries
 * at most once and only if re-logon reports success; never loops.
 */
export function makeWithRelogon(relogon: () => Promise<boolean>) {
  return async function withRelogon<T>(fn: () => Promise<T>, loggedOffInResult?: (r: T) => boolean): Promise<T> {
    try {
      const r = await fn();
      if (loggedOffInResult?.(r) && (await relogon())) return fn();
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isLoggedOffMessage(msg) && (await relogon())) return fn();
      throw e;
    }
  };
}
