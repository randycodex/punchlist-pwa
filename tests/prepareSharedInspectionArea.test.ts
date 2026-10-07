vi.mock('@/lib/collaboration/areaLocking', () => ({ AREA_LOCKING_ENABLED: true }));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claim, refresh } = vi.hoisted(() => ({ claim: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/collaboration/areaClaims', () => ({ claimSharedProjectArea: claim }));
vi.mock('@/features/sync/refreshSharedProject', () => ({ refreshSharedProject: refresh }));
import { prepareSharedInspectionArea } from '@/features/inspection/prepareSharedInspectionArea';

beforeEach(() => { vi.resetAllMocks(); claim.mockResolvedValue({ id: 'claim' }); refresh.mockResolvedValue('current'); });

describe('opening a team inspection', () => {
  it('checks just the opening unit after acquiring its lock', async () => {
    const active = () => true;
    expect(await prepareSharedInspectionArea('local', 'shared', 'unit-8A', active)).toBe('current');
    expect(claim).toHaveBeenCalledWith('shared', 'unit-8A');
    expect(refresh).toHaveBeenCalledWith('local', active, 'unit-8A');
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
  });
  it('reports a teammate lock without first refreshing any inspection or media', async () => {
    const error = { code: '55P03', message: 'This area is locked by another user.' };
    claim.mockRejectedValue(error);
    await expect(prepareSharedInspectionArea('local', 'shared', 'unit-8A', () => true)).rejects.toEqual(error);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('does not refresh the old area after navigation or account change', async () => {
    expect(await prepareSharedInspectionArea('local', 'shared', 'unit-8A', () => false)).toBe('deferred');
    expect(refresh).not.toHaveBeenCalled();
  });
  it('does not finish opening before newer team work is refreshed', async () => {
    let finishRefresh!: (value: string) => void;
    refresh.mockReturnValue(new Promise((resolve) => { finishRefresh = resolve; }));
    let finished = false;
    const opening = prepareSharedInspectionArea('local', 'shared', 'unit-8A', () => true).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(finished).toBe(false);
    finishRefresh('updated');
    expect(await opening).toBe('updated');
  });
  it('keeps the review outcome for unsent local captures', async () => {
    refresh.mockResolvedValue('review');
    expect(await prepareSharedInspectionArea('local', 'shared', 'unit-8A', () => true)).toBe('review');
  });
});
