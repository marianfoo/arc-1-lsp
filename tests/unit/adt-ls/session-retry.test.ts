import { describe, expect, it, vi } from 'vitest';
import {
  isLoggedOffFederatedResult,
  isLoggedOffMessage,
  makeRelogon,
  makeWithRelogon,
} from '../../../src/adt-ls/session-retry.js';

describe('isLoggedOffMessage', () => {
  it.each([
    'Your user was logged off',
    'Your user was logged off (Session 001)',
    'the session was logged-off',
    'SAP session expired',
    'session was terminated',
    'session timed out',
    'session timed-out',
    'session is invalid',
    'logon failed',
    'logon required',
    'You are not logged on',
    'adt-ls tool abap_activate_objects error: HTTP 401',
    '401 Unauthorized',
  ])('matches lost-session text: %s', (msg) => {
    expect(isLoggedOffMessage(msg)).toBe(true);
  });

  it.each([
    'packageName is missing or empty',
    'Object ZFOO (CLAS/OC) not found via search.',
    'ABAP Class created successfully',
    'getLsUri returned no uri for /sap/bc/adt/oo/classes/zcl_x',
    'syntax error at line 401', // bare "401" must NOT trip the matcher
    'Writes are disabled (read-only mode).',
    '',
  ])('does NOT match unrelated text: %s', (msg) => {
    expect(isLoggedOffMessage(msg)).toBe(false);
  });
});

describe('isLoggedOffFederatedResult', () => {
  it('true when isError + logged-off text in content', () => {
    expect(isLoggedOffFederatedResult({ isError: true, content: [{ text: 'Your user was logged off' }] })).toBe(true);
  });
  it('joins multiple content parts before matching', () => {
    expect(
      isLoggedOffFederatedResult({ isError: true, content: [{ text: 'oops' }, { text: 'session expired' }] }),
    ).toBe(true);
  });
  it('false when isError but message is unrelated', () => {
    expect(isLoggedOffFederatedResult({ isError: true, content: [{ text: 'packageName is missing' }] })).toBe(false);
  });
  it('false when not an error (even if text mentions logged off)', () => {
    expect(isLoggedOffFederatedResult({ isError: false, content: [{ text: 'logged off' }] })).toBe(false);
  });
  it('false for missing/empty/odd shapes', () => {
    expect(isLoggedOffFederatedResult(undefined)).toBe(false);
    expect(isLoggedOffFederatedResult({})).toBe(false);
    expect(isLoggedOffFederatedResult({ isError: true })).toBe(false);
    expect(isLoggedOffFederatedResult('a string')).toBe(false);
  });
});

describe('makeRelogon (concurrency de-dup)', () => {
  it('shares one in-flight attempt across concurrent callers, then allows a fresh one', async () => {
    let resolveIt: (v: boolean) => void = () => {};
    const doRelogon = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveIt = res;
        }),
    );
    const relogon = makeRelogon(doRelogon);

    const a = relogon();
    const b = relogon();
    expect(doRelogon).toHaveBeenCalledTimes(1); // b reuses a's in-flight promise

    resolveIt(true);
    expect(await a).toBe(true);
    expect(await b).toBe(true);

    // once settled, the next loss starts a new attempt
    const c = relogon();
    expect(doRelogon).toHaveBeenCalledTimes(2);
    resolveIt(false);
    expect(await c).toBe(false);
  });
});

describe('makeWithRelogon', () => {
  it('returns the result and never re-logs on a clean success', async () => {
    const relogon = vi.fn(async () => true);
    const fn = vi.fn(async () => 'ok');
    const withRelogon = makeWithRelogon(relogon);
    expect(await withRelogon(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(relogon).not.toHaveBeenCalled();
  });

  it('re-logs on and retries once when fn throws a logged-off error', async () => {
    const relogon = vi.fn(async () => true);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Your user was logged off'))
      .mockResolvedValueOnce('healed');
    const withRelogon = makeWithRelogon(relogon);
    expect(await withRelogon(fn)).toBe('healed');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(relogon).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when re-logon fails (no retry)', async () => {
    const relogon = vi.fn(async () => false);
    const fn = vi.fn(async () => {
      throw new Error('session expired');
    });
    const withRelogon = makeWithRelogon(relogon);
    await expect(withRelogon(fn)).rejects.toThrow(/session expired/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(relogon).toHaveBeenCalledTimes(1);
  });

  it('does not re-logon for an unrelated thrown error', async () => {
    const relogon = vi.fn(async () => true);
    const fn = vi.fn(async () => {
      throw new Error('ABAP syntax error');
    });
    const withRelogon = makeWithRelogon(relogon);
    await expect(withRelogon(fn)).rejects.toThrow(/syntax error/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(relogon).not.toHaveBeenCalled();
  });

  it('re-logs on + retries when a federated result is flagged logged-off', async () => {
    const relogon = vi.fn(async () => true);
    const loggedOff = { isError: true, content: [{ text: 'Your user was logged off' }] };
    const healed = { isError: false, content: [{ text: 'done' }] };
    const fn = vi.fn<() => Promise<unknown>>().mockResolvedValueOnce(loggedOff).mockResolvedValueOnce(healed);
    const withRelogon = makeWithRelogon(relogon);
    expect(await withRelogon(fn, isLoggedOffFederatedResult)).toBe(healed);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(relogon).toHaveBeenCalledTimes(1);
  });

  it('returns the still-logged-off result without looping when the retry also fails', async () => {
    const relogon = vi.fn(async () => true);
    const loggedOff = { isError: true, content: [{ text: 'logged off' }] };
    const fn = vi.fn(async () => loggedOff);
    const withRelogon = makeWithRelogon(relogon);
    expect(await withRelogon(fn, isLoggedOffFederatedResult)).toBe(loggedOff);
    expect(fn).toHaveBeenCalledTimes(2); // one retry only — no infinite loop
    expect(relogon).toHaveBeenCalledTimes(1);
  });

  it('does not retry a logged-off result when re-logon fails', async () => {
    const relogon = vi.fn(async () => false);
    const loggedOff = { isError: true, content: [{ text: 'session terminated' }] };
    const fn = vi.fn(async () => loggedOff);
    const withRelogon = makeWithRelogon(relogon);
    expect(await withRelogon(fn, isLoggedOffFederatedResult)).toBe(loggedOff);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(relogon).toHaveBeenCalledTimes(1);
  });
});
