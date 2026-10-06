import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment } from '@/lib/db';
import { buildSharedSnapshotAssetPlan } from '@/lib/collaboration/sharedSnapshotAssets';
import { createCompactSharedSnapshotPayload } from '@/lib/collaboration/sharedSnapshotPayload';
import { getSharedAttachmentRecoveryCopies } from '@/lib/collaboration/sharedProjectSnapshots';

const { from, download } = vi.hoisted(() => ({ from: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/collaboration/supabaseClient', () => ({ getCollaborationSupabaseClient: () => ({
  from, storage: { from: () => ({ download }) },
}) }));

beforeEach(() => { from.mockReset(); download.mockReset(); });

async function fixture() {
  const local = createProject('Keep device inspection');
  local.sharedProjectId = crypto.randomUUID();
  const area = createArea(local.id, 'Unit 203', 0);
  area.notes = 'Unsent device note'; area.sharedVersion = 3;
  const room = createLocation(area.id, 'Bedroom', 0);
  const item = createItem(room.id, 'Door', 0);
  const checkpoint = createCheckpoint(item.id, 'Finish', 0);
  checkpoint.comments = 'Unsent checkpoint comment';
  checkpoint.photos = ['YQ==', 'Yg=='].map((bytes) => createPhotoAttachment(checkpoint.id, `data:image/png;base64,${bytes}`));
  item.checkpoints = [checkpoint]; room.items = [item]; area.locations = [room]; local.areas = [area];
  const plan = await buildSharedSnapshotAssetPlan(local);
  const payload = createCompactSharedSnapshotPayload(local, plan.assets);
  const query = { select: vi.fn(), eq: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn(), then: vi.fn() };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.gt.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { project_payload: payload, payload_version: 2, published_at: '2026-10-01' }, error: null });
  query.then.mockImplementation((resolve: (result: unknown) => void) => resolve({ data: [], error: null }));
  from.mockReturnValue(query);
  download.mockImplementation(async (path: string) => {
    const upload = plan.uploads.find((entry) => entry.reference.path === path)!;
    return { data: new Blob([atob(upload.dataUrl.split(',')[1])], { type: upload.reference.mimeType }), error: null };
  });
  return { local, area, checkpoint, plan, query };
}

describe('targeted Team attachment recovery', () => {
  it('downloads only requested attachment bytes and retains the local inspection metadata', async () => {
    const { local, area, checkpoint, query } = await fixture();
    const photo = checkpoint.photos[0];
    const recovered = await getSharedAttachmentRecoveryCopies(local, [photo.id], area.id);
    expect(download).toHaveBeenCalledOnce();
    expect(recovered.id).toBe(local.id);
    expect(recovered.areas[0].notes).toBe('Unsent device note');
    expect(recovered.areas[0].sharedVersion).toBe(3);
    expect(recovered.areas[0].locations[0].items[0].checkpoints[0]).toMatchObject({
      comments: 'Unsent checkpoint comment', photos: [photo],
    });
    expect(query.eq).toHaveBeenCalledWith('area_id', area.id);
  });

  it('uses the newer area attachment copy without adopting the remote notes or revision', async () => {
    const { local, area, checkpoint, query } = await fixture();
    const remote = structuredClone(local);
    remote.areas[0].notes = 'Old cloud note'; remote.areas[0].sharedVersion = 99;
    remote.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData = 'data:image/png;base64,Yw==';
    const updated = await buildSharedSnapshotAssetPlan(remote);
    query.then.mockImplementation((resolve: (result: unknown) => void) => resolve({
      data: [{ area_payload: createCompactSharedSnapshotPayload(remote, updated.assets), payload_version: 2 }], error: null,
    }));
    download.mockResolvedValue({ data: new Blob(['c'], { type: 'image/png' }), error: null });
    const recovered = await getSharedAttachmentRecoveryCopies(local, [checkpoint.photos[0].id], area.id);
    expect(recovered.areas[0]).toMatchObject({ notes: 'Unsent device note', sharedVersion: 3 });
    expect(recovered.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/png;base64,Yw==');
    expect(download).toHaveBeenCalledOnce();
  });

  it('rejects mismatched downloaded bytes without returning a recovery copy', async () => {
    const { local, checkpoint } = await fixture();
    download.mockResolvedValue({ data: new Blob(['wrong'], { type: 'image/png' }), error: null });
    await expect(getSharedAttachmentRecoveryCopies(local, [checkpoint.photos[0].id])).rejects.toThrow('verification');
    expect(checkpoint.photos[0].imageData).toBe('data:image/png;base64,YQ==');
  });
});
