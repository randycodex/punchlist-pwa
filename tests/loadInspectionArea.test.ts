import { beforeEach, describe, expect, it, vi } from 'vitest';
const { read, count, preview } = vi.hoisted(() => ({ read: vi.fn(), count: vi.fn(), preview: vi.fn() }));
vi.mock('@/lib/db', () => ({ getProjectForArea: read, getActiveProjectCount: count, getProjectForAreaPreview: preview }));
import { AreaUnavailableError, loadInspectionArea } from '@/features/inspection/loadInspectionArea';

beforeEach(() => { read.mockReset(); count.mockReset(); preview.mockReset(); count.mockResolvedValue(2); });
describe('opening an inspection area', () => {
  it('keeps a readable area accessible when the optional project count fails', async () => {
    const project = { id: 'p', areas: [{ id: 'a' }] };
    read.mockResolvedValue(project);
    count.mockRejectedValue(new DOMException('The object can not be found here.', 'NotFoundError'));
    expect(await loadInspectionArea('p', 'a')).toMatchObject({ project, area: project.areas[0], returnToHome: false, unreadableAttachments: [] });
  });
  it('opens a display preview after an attachment failure and allows a later retry', async () => {
    const error = new Error('Could not finish opening saved photos and files on this device. The object can not be found here.');
    const project = { id: 'p', areas: [{ id: 'a', notes: 'Unsent note' }] };
    const unreadableAttachments = [{ id: 'photo', checkpointId: 'cp', areaId: 'a', kind: 'photo' }];
    read.mockRejectedValueOnce(error).mockResolvedValueOnce(project);
    preview.mockResolvedValue({ project, unreadableAttachments });
    const first = await loadInspectionArea('p', 'a');
    expect(first).toMatchObject({ project, area: project.areas[0], unreadableAttachments });
    expect(first.mediaError?.message).toContain(error.message);
    expect(await loadInspectionArea('p', 'a')).toMatchObject({ area: project.areas[0], unreadableAttachments: [], mediaError: undefined });
  });
  it('does not conceal a project-record or database failure as a media preview', async () => {
    const error = new Error('Could not finish reading the project record on this device.');
    read.mockRejectedValue(error);
    await expect(loadInspectionArea('p', 'a')).rejects.toBe(error);
    expect(preview).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, 'project is not saved'],
    [{ deletedAt: new Date(), areas: [] }, 'project is in Trash'],
    [{ areas: [] }, 'area is not available'],
    [{ areas: [{ id: 'a', deletedAt: new Date() }] }, 'area is not available'],
  ])('reports an unavailable local copy without silently navigating away', async (project, message) => {
    read.mockResolvedValue(project);
    await expect(loadInspectionArea('p', 'a')).rejects.toBeInstanceOf(AreaUnavailableError);
    await expect(loadInspectionArea('p', 'a')).rejects.toThrow(message as string);
  });
});
