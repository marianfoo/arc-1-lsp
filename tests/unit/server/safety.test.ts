import { describe, expect, it } from 'vitest';
import { assertWriteAllowed, isPackageAllowed } from '../../../src/server/safety.js';

describe('isPackageAllowed', () => {
  it('matches exact (case-insensitive)', () => {
    expect(isPackageAllowed(['$TMP'], '$TMP')).toBe(true);
    expect(isPackageAllowed(['$TMP'], '$tmp')).toBe(true);
    expect(isPackageAllowed(['$TMP'], 'ZFOO')).toBe(false);
  });
  it('matches PREFIX* wildcard', () => {
    expect(isPackageAllowed(['Z*'], 'ZFOO')).toBe(true);
    expect(isPackageAllowed(['Z*'], 'YFOO')).toBe(false);
  });
  it('matches `*` (any)', () => {
    expect(isPackageAllowed(['*'], 'ANYTHING')).toBe(true);
  });
});

describe('assertWriteAllowed', () => {
  it('throws when writes are disabled', () => {
    expect(() =>
      assertWriteAllowed({ allowWrites: false, allowedPackages: ['$TMP'] }, { action: 'create_object' }),
    ).toThrow(/Writes are disabled/);
  });
  it('passes when writes enabled and no package given', () => {
    expect(() =>
      assertWriteAllowed({ allowWrites: true, allowedPackages: ['$TMP'] }, { action: 'activate' }),
    ).not.toThrow();
  });
  it('throws when the package is not in the allowlist', () => {
    expect(() =>
      assertWriteAllowed({ allowWrites: true, allowedPackages: ['$TMP'] }, { action: 'create', packageName: 'ZPROD' }),
    ).toThrow(/not in the write allowlist/);
  });
  it('passes when the package is allowed', () => {
    expect(() =>
      assertWriteAllowed(
        { allowWrites: true, allowedPackages: ['$TMP', 'Z*'] },
        { action: 'create', packageName: 'ZFOO' },
      ),
    ).not.toThrow();
  });
});
