import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalStorage, writeLocalStorage } from '@/lib/browserStorage';

describe('browser storage helpers', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fallbacks when local storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);

    expect(readLocalStorage('key')).toBeNull();
    expect(writeLocalStorage('key', 'value')).toBe(false);
  });

  it('does not throw when local storage access is blocked', () => {
    const blockedStorage = {
      getItem: vi.fn(() => {
        throw new DOMException('Storage is blocked.', 'SecurityError');
      }),
      setItem: vi.fn(() => {
        throw new DOMException('Storage is blocked.', 'SecurityError');
      }),
    };
    vi.stubGlobal('localStorage', blockedStorage);

    expect(readLocalStorage('key')).toBeNull();
    expect(writeLocalStorage('key', 'value')).toBe(false);
  });
});
