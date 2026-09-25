import { describe, expect, it } from 'vitest';
import { assessRecoveredCopy, formatRecoveryDifferenceSummary } from '../src/features/projects/reconcileRecoveredCopy';
import type { Project } from '../src/types';

function copy(id: string): Project {
  const date = new Date('2026-09-24T00:00:00Z');
  return {
    id,
    projectName: id === 'recovered' ? 'Recovered local copy - Ilse Hoffman House' : 'Ilse Hoffman House - K&J (Kwassi)',
    recoveredFromProjectId: id === 'recovered' ? 'retained' : undefined,
    address: '1760 Jerome Ave', date, inspector: '', gcName: '', gcSignoff: '',
    createdAt: date, updatedAt: date,
    areas: [{
      id: 'area', projectId: id, name: 'Unit 1', sortOrder: 0, isComplete: false,
      notes: '', createdAt: date, updatedAt: date,
      locations: [{
        id: 'room', areaId: 'area', name: 'Kitchen', sortOrder: 0,
        createdAt: date, updatedAt: date,
        items: [{
          id: 'item', locationId: 'room', name: 'Sink', sortOrder: 0,
          createdAt: date, updatedAt: date,
          checkpoints: [{
            id: 'checkpoint', itemId: 'item', name: 'Inspect', status: 'needsReview',
            fixStatus: 'pending', comments: 'Leak', sortOrder: 0, createdAt: date, updatedAt: date,
            photos: [{ id: 'photo', checkpointId: 'checkpoint', imageData: 'data:image/jpeg;base64,abc', createdAt: date }],
            files: [],
          }],
        }],
      }],
    }],
  };
}

describe('automatic recovery reconciliation', () => {
  it('archives only when the retained project contains the recovery work', () => {
    const recovery = copy('recovered');
    const retained = copy('retained');
    retained.areas.push({ ...retained.areas[0], id: 'new-area', projectId: retained.id, locations: [] });
    expect(assessRecoveredCopy(recovery, retained)).toMatchObject({ safeToArchive: true, differenceCount: 0 });
  });

  it('keeps a recovery copy with any saved detail or media missing from the retained copy', () => {
    const recovery = copy('recovered');
    const retained = copy('retained');
    retained.areas[0].locations[0].items[0].checkpoints[0].comments = 'Different note';
    retained.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData = '';
    const result = assessRecoveredCopy(recovery, retained);
    expect(result.safeToArchive).toBe(false);
    expect(result.differenceCount).toBe(2);
    expect(result.differences).toMatchObject({ changedCheckpoints: 1, changedPhotos: 1 });
    expect(formatRecoveryDifferenceSummary(result)).toContain('1 checkpoint outcomes/details');
  });

  it('keeps room reviews, area notes, and attached files that differ', () => {
    const recovery = copy('recovered');
    const retained = copy('retained');
    recovery.areas[0].notes = 'Office note';
    recovery.areas[0].locations[0].reviewedAt = '2026-09-24T10:00:00Z';
    recovery.areas[0].locations[0].items[0].checkpoints[0].files = [{
      id: 'file', checkpointId: 'checkpoint', name: 'report.pdf', mimeType: 'application/pdf',
      size: 3, data: 'data:pdf', createdAt: recovery.date,
    }];
    expect(assessRecoveredCopy(recovery, retained).differenceCount).toBe(3);
  });

  it('does not mistake project counts, names, or different drawings for equivalence', () => {
    const recovery = copy('recovered');
    const retained = copy('retained');
    recovery.facadeElevationDrawings = [{
      id: 'recovery-drawing', orientation: 'West', name: 'Elevation', fileName: 'west.png',
      mimeType: 'image/png', size: 3, dataUrl: 'data:one', createdAt: recovery.date, updatedAt: recovery.date,
    }];
    retained.facadeElevationDrawings = [{
      ...recovery.facadeElevationDrawings[0], id: 'retained-drawing', dataUrl: 'data:two',
    }];
    recovery.areas[0].elevationDrawingId = 'recovery-drawing';
    retained.areas[0].elevationDrawingId = 'retained-drawing';
    expect(assessRecoveredCopy(recovery, retained).safeToArchive).toBe(false);
  });

  it('accepts rekeyed drawings only when their actual file data matches', () => {
    const recovery = copy('recovered');
    const retained = copy('retained');
    const drawing = {
      id: 'recovery-drawing', orientation: 'West', name: 'Elevation', fileName: 'west.png',
      mimeType: 'image/png', size: 3, dataUrl: 'data:one', createdAt: recovery.date, updatedAt: recovery.date,
    };
    recovery.facadeElevationDrawings = [drawing];
    retained.facadeElevationDrawings = [{ ...drawing, id: 'retained-drawing' }];
    recovery.areas[0].elevationDrawingId = drawing.id;
    retained.areas[0].elevationDrawingId = 'retained-drawing';
    expect(assessRecoveredCopy(recovery, retained).safeToArchive).toBe(true);
  });
});
