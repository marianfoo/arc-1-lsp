import { describe, expect, it } from 'vitest';
import { checkApiKey, parseApiKeys } from '../../../src/server/auth.js';

describe('parseApiKeys', () => {
  it('returns [] for empty/undefined', () => {
    expect(parseApiKeys()).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
  });
  it('parses keys with and without labels', () => {
    expect(parseApiKeys('k1:dev, k2 , k3:ops')).toEqual([
      { key: 'k1', label: 'dev' },
      { key: 'k2' },
      { key: 'k3', label: 'ops' },
    ]);
  });
});

describe('checkApiKey', () => {
  const keys = parseApiKeys('secret:dev');
  it('disables auth when no keys are configured', () => {
    expect(checkApiKey({}, [])).toBe(true);
  });
  it('accepts a valid Bearer token', () => {
    expect(checkApiKey({ authorization: 'Bearer secret' }, keys)).toBe(true);
  });
  it('accepts a valid x-api-key header', () => {
    expect(checkApiKey({ 'x-api-key': 'secret' }, keys)).toBe(true);
  });
  it('rejects an unknown key', () => {
    expect(checkApiKey({ authorization: 'Bearer nope' }, keys)).toBe(false);
  });
  it('rejects a missing key', () => {
    expect(checkApiKey({}, keys)).toBe(false);
  });
});
