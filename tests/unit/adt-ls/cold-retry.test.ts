import { describe, expect, it, vi } from 'vitest';
import { isTransientColdError, withColdRetry } from '../../../src/adt-ls/cold-retry.js';

const noSleep = async () => {};

describe('withColdRetry', () => {
  it('returns the first result when it is acceptable (no retry)', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withColdRetry(fn, { retryResult: () => false, sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a "cold" result (retryResult true) until one is acceptable', async () => {
    const results = [{ n: 0 }, { n: 0 }, { n: 5 }];
    let i = 0;
    const fn = vi.fn(async () => results[i++]);
    const r = await withColdRetry(fn, { attempts: 4, retryResult: (x) => x.n === 0, sleep: noSleep });
    expect(r).toEqual({ n: 5 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns the last result even if still "cold" once attempts are exhausted (never hides it)', async () => {
    const fn = vi.fn(async () => ({ n: 0 }));
    const r = await withColdRetry(fn, { attempts: 3, retryResult: (x) => x.n === 0, sleep: noSleep });
    expect(r).toEqual({ n: 0 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries a transient throw (retryError true) then returns the eventual success', async () => {
    let i = 0;
    const fn = vi.fn(async () => {
      if (i++ < 2) throw new Error('Internal error');
      return 'recovered';
    });
    const r = await withColdRetry(fn, { attempts: 4, retryError: isTransientColdError, sleep: noSleep });
    expect(r).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-transient error — rethrows immediately', async () => {
    const fn = vi.fn(async () => {
      throw new Error('not authorized');
    });
    await expect(withColdRetry(fn, { attempts: 4, retryError: isTransientColdError, sleep: noSleep })).rejects.toThrow(
      /not authorized/,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last error when a transient throw never recovers', async () => {
    const fn = vi.fn(async () => {
      throw new Error('Internal error');
    });
    await expect(withColdRetry(fn, { attempts: 3, retryError: isTransientColdError, sleep: noSleep })).rejects.toThrow(
      /Internal error/,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses linear backoff via the injected sleep (delayMs * attempt)', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    let i = 0;
    await withColdRetry(async () => (i++ < 2 ? { n: 0 } : { n: 1 }), {
      attempts: 4,
      delayMs: 500,
      retryResult: (x) => x.n === 0,
      sleep,
    });
    expect(delays).toEqual([500, 1000]); // before attempt 2 and attempt 3
  });
});

describe('isTransientColdError', () => {
  it('matches adt-ls cold signatures', () => {
    expect(isTransientColdError(new Error('Internal error'))).toBe(true);
    expect(isTransientColdError(new Error('Request failed: INTERNAL ERROR'))).toBe(true);
    expect(isTransientColdError('please try again later')).toBe(true);
  });
  it('does not match real errors', () => {
    expect(isTransientColdError(new Error('not authorized'))).toBe(false);
    expect(isTransientColdError(new Error('object ZCL_X not found'))).toBe(false);
  });
});
