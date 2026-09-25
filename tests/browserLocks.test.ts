import { afterEach, expect, it, vi } from 'vitest';
import { withBrowserLock } from '@/lib/browserLocks';

afterEach(() => vi.unstubAllGlobals());

it('serializes same-name work without Web Locks while unrelated work proceeds', async () => {
  vi.stubGlobal('navigator', {});
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withBrowserLock('save', async () => {
    events.push('first-start'); await gate; events.push('first-end');
  });
  const second = withBrowserLock('save', async () => { events.push('second'); });
  await withBrowserLock('unrelated', async () => { events.push('unrelated'); });
  expect(events).toEqual(['first-start', 'unrelated']);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(['first-start', 'unrelated', 'first-end', 'second']);
});

it('does not strand later saves after a failed operation', async () => {
  vi.stubGlobal('navigator', {});
  const first = withBrowserLock('save', async () => { throw new Error('Disk full'); });
  const second = withBrowserLock('save', async () => 'saved');
  await expect(first).rejects.toThrow('Disk full');
  await expect(second).resolves.toBe('saved');
  await expect(withBrowserLock('save', async () => 'next')).resolves.toBe('next');
});
