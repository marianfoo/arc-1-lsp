import { describe, expect, it } from 'vitest';
import { checkApiKey, parseApiKeys, resolveApiKey } from '../../../src/server/auth.js';

describe('parseApiKeys', () => {
  it('returns [] for empty/undefined', () => {
    expect(parseApiKeys()).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
  });
  it('parses keys with non-profile labels → developer profile (back-compat)', () => {
    expect(parseApiKeys('k1:dev, k2 , k3:ops')).toEqual([
      { key: 'k1', label: 'dev', profile: 'developer', scopes: ['read', 'write'] },
      { key: 'k2', profile: 'developer', scopes: ['read', 'write'] },
      { key: 'k3', label: 'ops', profile: 'developer', scopes: ['read', 'write'] },
    ]);
  });
  it('resolves a known profile suffix to its scopes', () => {
    expect(parseApiKeys('vk:viewer, ak:admin')).toEqual([
      { key: 'vk', label: 'viewer', profile: 'viewer', scopes: ['read'] },
      { key: 'ak', label: 'admin', profile: 'admin', scopes: ['admin'] },
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

describe('resolveApiKey', () => {
  const keys = parseApiKeys('vk:viewer, dk:developer');
  it('returns the matched key (with profile + scopes) for a valid credential', () => {
    expect(resolveApiKey({ authorization: 'Bearer vk' }, keys)).toMatchObject({ key: 'vk', profile: 'viewer' });
    expect(resolveApiKey({ 'x-api-key': 'dk' }, keys)).toMatchObject({ key: 'dk', scopes: ['read', 'write'] });
  });
  it('returns null for an unknown or missing credential', () => {
    expect(resolveApiKey({ authorization: 'Bearer nope' }, keys)).toBeNull();
    expect(resolveApiKey({}, keys)).toBeNull();
  });
});
