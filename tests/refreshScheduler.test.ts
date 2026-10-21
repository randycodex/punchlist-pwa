import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRefreshScheduler } from '@/features/sync/refreshScheduler';

afterEach(() => { vi.useRealTimers(); });
describe('realtime refresh scheduling', () => {
  it('coalesces a burst of updates into one refresh after 250 ms', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler(run);
    for (let count = 0; count < 20; count++) scheduler.schedule();
    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
  it('keeps updates arriving during a slow refresh without overlapping requests', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const run = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const scheduler = createRefreshScheduler(run);
    scheduler.schedule();
    await vi.advanceTimersByTimeAsync(250);
    scheduler.schedule(); scheduler.schedule();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it('cancels pending work and follow-ups after navigation or sign-out', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = createRefreshScheduler(run);
    scheduler.schedule(); scheduler.dispose(); scheduler.schedule();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();
  });
});
