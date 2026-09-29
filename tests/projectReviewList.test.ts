import { describe, expect, it } from 'vitest';
import { buildProjectReviewList } from '@/features/projects/reviewList';
import { createArea, createCheckpoint, createItem, createLocation, createProject } from '@/lib/db';

describe('project review list', () => {
  it('includes comments, photos, files, issues, and area notes with their full location', () => {
    const project = createProject('Building', '123 Main St', '');
    const area = createArea(project.id, 'Unit 2A', 0);
    area.unitFloor = '-1';
    area.notes = 'Check the corridor';
    const room = createLocation(area.id, 'Living Room', 0);
    const item = createItem(room.id, 'Paint', 0);
    const empty = createCheckpoint(item.id, 'No activity', 0);
    const comment = createCheckpoint(item.id, 'Walls', 1);
    comment.comments = 'Touch up';
    const photo = createCheckpoint(item.id, 'Ceiling', 2);
    photo.photos = [{ id: 'photo', checkpointId: photo.id, imageData: '', createdAt: new Date() }];
    const issue = createCheckpoint(item.id, 'Trim', 3);
    issue.status = 'needsReview';
    issue.issueState = 'resolved';
    const file = createCheckpoint(item.id, 'Door', 4);
    file.files = [{ id: 'file', checkpointId: file.id, name: 'note.pdf', mimeType: 'application/pdf', size: 1, data: '', createdAt: new Date() }];
    item.checkpoints = [empty, comment, photo, issue, file];
    room.items = [item];
    area.locations = [room];
    project.areas = [area];

    const entries = buildProjectReviewList(project);
    expect(entries.map((entry) => entry.title)).toEqual(['Area notes', 'Walls', 'Ceiling', 'Trim', 'Door']);
    expect(entries[1].path).toEqual(['Cellar', 'Unit 2A', 'Living Room', 'Paint']);
    expect(entries[2].photoCount).toBe(1);
    expect(entries[3].issueState).toBe('resolved');
  });

  it('omits deleted areas', () => {
    const project = createProject('Building', '', '');
    const area = createArea(project.id, 'Unit 2A', 0);
    area.notes = 'Hidden';
    area.deletedAt = new Date();
    project.areas = [area];
    expect(buildProjectReviewList(project)).toEqual([]);
  });
});
