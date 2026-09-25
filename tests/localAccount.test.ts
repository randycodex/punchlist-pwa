import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
}

describe('account-local workspaces', () => {
  it('retains the remembered account legacy workspace and isolates a different sign-in after reload', async () => {
    storage();
    const first = await import('@/lib/localAccount');
    expect(first.configureLocalAccount('account-a', 'a@example.com', 'account-a')).toBe(true);
    expect(first.localAccountKey('punchlist-db')).toBe('punchlist-db');
    expect(first.configureLocalAccount('account-b', 'b@example.com', 'account-a')).toBe(false);
    expect(() => first.assertLocalAccountEmail('b@example.com')).toThrow('account changed');
    vi.resetModules();
    const second = await import('@/lib/localAccount');
    expect(second.configureLocalAccount('account-b', 'b@example.com', 'account-a')).toBe(true);
    expect(second.localAccountKey('punchlist-db')).toBe('punchlist-db:account-b');
    expect(second.localAccountKey('punchlist-capture-recovery')).toBe('punchlist-capture-recovery:account-b');
    expect(() => second.assertLocalAccountEmail('a@example.com')).toThrow('account changed');
  });

  it('keeps pre-account offline inspections with the first owner across reloads', async () => {
    storage();
    const first = await import('@/lib/localAccount');
    first.configureLocalAccount('new-account', 'new@example.com', null);
    expect(first.localAccountKey('punchlist-db')).toBe('punchlist-db');
    vi.resetModules();
    const second = await import('@/lib/localAccount');
    second.configureLocalAccount('new-account', 'new@example.com', 'new-account');
    expect(second.localAccountKey('punchlist-db')).toBe('punchlist-db');
  });

  it('reopens the last account workspace offline without allowing team requests', async () => {
    storage();
    const first = await import('@/lib/localAccount');
    first.configureLocalAccount('account-a', 'a@example.com', null);
    vi.resetModules();
    const second = await import('@/lib/localAccount');
    second.configureLocalAccount('account-b', 'b@example.com', 'account-a');
    vi.resetModules();
    const offline = await import('@/lib/localAccount');
    expect(offline.configureLocalAccount(null, null, 'account-b')).toBe(true);
    expect(offline.localAccountKey('punchlist-db')).toBe('punchlist-db:account-b');
    expect(offline.localAccountKey('punchlist:app-settings')).toBe('punchlist:app-settings:account-b');
    expect(() => offline.assertLocalAccountEmail('b@example.com')).toThrow('account changed');
  });
});
