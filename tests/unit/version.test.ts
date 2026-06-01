import { describe, expect, it, vi } from 'vitest';
import { EXPECTED_ADT_LS_VERSION, VERSION, warnOnAdtLsVersionMismatch } from '../../src/version.js';

describe('VERSION', () => {
  it('is a semver string (release-please target)', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });
});

describe('warnOnAdtLsVersionMismatch', () => {
  it('does not warn when the detected version matches the expected one', () => {
    const warn = vi.fn();
    warnOnAdtLsVersionMismatch(EXPECTED_ADT_LS_VERSION, warn);
    expect(warn).not.toHaveBeenCalled();
  });
  it('does not warn when the version is undefined (nothing to compare)', () => {
    const warn = vi.fn();
    warnOnAdtLsVersionMismatch(undefined, warn);
    expect(warn).not.toHaveBeenCalled();
  });
  it('warns once, naming both versions, on a mismatch', () => {
    const warn = vi.fn();
    warnOnAdtLsVersionMismatch('9.9.9.999', warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('9.9.9.999');
    expect(warn.mock.calls[0][0]).toContain(EXPECTED_ADT_LS_VERSION);
  });
});
