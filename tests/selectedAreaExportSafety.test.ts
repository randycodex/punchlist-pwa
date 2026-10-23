import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('@/lib/pdfExport', () => ({ generateProjectPDF: mocks.render }));
import { generateSelectedAreaExport } from '@/features/export/selectedAreaExport';
import { loadProjectForExport } from '@/features/export/loadProjectForExport';
import {
  createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment,
  getProject, saveProjectPreserveTimestamps, saveAreaNotes, getPendingSharedAreaSyncsForProject,
} from '@/lib/db';
import { stageCaptureDraft, listCaptureDrafts } from '@/lib/captureJournal';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('keeps saved photos, queued work and drafts on export (failure: %s)', async (fail) => {
  const project = createProject('Export safety fixture');
  project.sharedProjectId = crypto.randomUUID();
  for (const name of ['First', 'Second', 'Unselected']) {
    const area = createArea(project.id, name, project.areas.length);
    const room = createLocation(area.id, 'Room', 0);
    const item = createItem(room.id, 'Wall', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    checkpoint.photos.push(createPhotoAttachment(checkpoint.id, 'data:image/jpeg;base64,cGhvdG8='));
    item.checkpoints.push(checkpoint); room.items.push(item); area.locations.push(room); project.areas.push(area);
  }
  await saveProjectPreserveTimestamps(project);
  await saveAreaNotes(project.id, project.areas[0].id, 'Unsent note');
  const area = project.areas[0];
  await stageCaptureDraft({ key: `note:${project.id}`, revision: crypto.randomUUID(), projectId: project.id, areaId: area.id, checkpointId: area.locations[0].items[0].checkpoints[0].id, kind: 'note', value: 'Still typing', baseValue: '', savedAt: new Date() });
  const state = async () => ({ project: await getProject(project.id), queue: await getPendingSharedAreaSyncsForProject(project.id), drafts: await listCaptureDrafts(project.id, area.id) });
  const before = await state();
  const ids = project.areas.slice(0, 2).map((entry) => entry.id);
  const loaded = await loadProjectForExport(project.id, 'full', ids);
  expect(loaded.areas.map((entry) => entry.id)).toEqual(ids);
  mocks.render.mockReset().mockImplementation(async (snapshot) => {
    expect(snapshot.areas).toHaveLength(1);
    expect(snapshot.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('data:image/jpeg;base64,cGhvdG8=');
    if (fail && snapshot.areas[0].id === ids[1]) throw new Error('PDF generation failed');
    return new Blob(['%PDF-fixture']);
  });
  const result = generateSelectedAreaExport(loaded, ids, 'full', 'individual');
  if (fail) await expect(result).rejects.toThrow('PDF generation failed');
  else expect((await result).extension).toBe('zip');
  expect(await state()).toEqual(before);
});

describe('ZIP generation scheduling', () => {
  it('finishes each PDF before starting the next', async () => {
    const project = createProject('Sequential fixture');
    project.areas = ['A', 'B'].map((name, index) => createArea(project.id, name, index));
    let active = 0;
    let maxActive = 0;
    mocks.render.mockReset().mockImplementation(async () => {
      active++; maxActive = Math.max(active, maxActive);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return new Blob(['%PDF-fixture']);
    });
    await generateSelectedAreaExport(project, project.areas.map((area) => area.id), 'full', 'individual');
    expect(maxActive).toBe(1);
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });
});
