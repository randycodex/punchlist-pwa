import { beforeEach, describe, expect, it, vi } from 'vitest';
const { read, count } = vi.hoisted(() => ({ read: vi.fn(), count: vi.fn() }));
vi.mock('@/lib/db', () => ({ getProjectForArea: read, getActiveProjectCount: count }));
import { AreaUnavailableError, loadInspectionArea } from '@/features/inspection/loadInspectionArea';

beforeEach(() => { read.mockReset(); count.mockReset(); count.mockResolvedValue(2); });
describe('opening an inspection area', () => {
  it('keeps a readable area accessible when the optional project count fails', async () => {
    const project = { id: 'p', areas: [{ id: 'a' }] };
    read.mockResolvedValue(project);
    count.mockRejectedValue(new DOMException('The object can not be found here.', 'NotFoundError'));
    expect(await loadInspectionArea('p', 'a')).toEqual({ project, area: project.areas[0], returnToHome: false });
  });
  it('preserves attachment error details and allows a later retry', async () => {
    const error = new Error('Could not finish opening saved photos and files on this device. The object can not be found here.');
    read.mockRejectedValueOnce(error).mockResolvedValueOnce({ id: 'p', areas: [{ id: 'a' }] });
    await expect(loadInspectionArea('p', 'a')).rejects.toBe(error);
    expect((await loadInspectionArea('p', 'a')).area.id).toBe('a');
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
