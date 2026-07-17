import { describe, expect, it } from 'vitest';
import type { Project } from '@/types';
import {
  buildSharedSnapshotAssetPlan,
  hydrateSharedSnapshotAssetsWithResolver,
  type SharedAttachmentMetadataRow,
} from '@/lib/collaboration/sharedSnapshotAssets';
import {
  COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION,
  createCompactSharedSnapshotPayload,
  getSharedSnapshotProjectName,
  parseSharedSnapshotPayload,
} from '@/lib/collaboration/sharedSnapshotPayload';

const timestamp = new Date('2026-07-17T12:00:00.000Z');
const photoData = `data:image/jpeg;base64,${'A'.repeat(4_000)}`;
const thumbnailData = `data:image/jpeg;base64,${'B'.repeat(800)}`;
const fileData = `data:application/pdf;base64,${'C'.repeat(2_000)}`;
const drawingData = `data:image/png;base64,${'D'.repeat(6_000)}`;

function projectWithAssets(): Project {
  return {
    id: 'local-project-1',
    sharedProjectId: 'shared-project-1',
    projectName: 'Compact shared project',
    address: 'Test address',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    facadeElevationDrawings: [{
      id: 'drawing-1',
      orientation: 'north',
      name: 'North elevation',
      fileName: 'north.png',
      mimeType: 'image/png',
      size: 4_500,
      dataUrl: drawingData,
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    areas: [{
      id: 'area-1',
      projectId: 'local-project-1',
      name: 'Area 1',
      sortOrder: 0,
      isComplete: false,
      notes: '',
      locations: [{
        id: 'location-1',
        areaId: 'area-1',
        name: 'Room',
        sortOrder: 0,
        items: [{
          id: 'item-1',
          locationId: 'location-1',
          name: 'Window',
          sortOrder: 0,
          checkpoints: [{
            id: 'checkpoint-1',
            itemId: 'item-1',
            name: 'Finish',
            status: 'needsReview',
            fixStatus: 'pending',
            issueState: 'open',
            comments: 'Repair finish',
            sortOrder: 0,
            photos: [{
              id: 'photo-1',
              checkpointId: 'checkpoint-1',
              imageData: photoData,
              thumbnail: thumbnailData,
              createdAt: timestamp,
            }],
            files: [{
              id: 'file-1',
              checkpointId: 'checkpoint-1',
              name: 'detail.pdf',
              mimeType: 'application/pdf',
              size: 1_500,
              data: fileData,
              createdAt: timestamp,
            }],
            createdAt: timestamp,
            updatedAt: timestamp,
          }],
          createdAt: timestamp,
          updatedAt: timestamp,
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('compact shared snapshot payloads', () => {
  it('keeps legacy inline version-1 snapshots readable', () => {
    const project = projectWithAssets();
    const parsed = parseSharedSnapshotPayload(JSON.parse(JSON.stringify(project)), 1);

    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(photoData);
    expect(parsed.project.updatedAt).toBeInstanceOf(Date);
    expect(parsed.assets).toEqual({ photos: {}, files: {}, drawings: {} });
  });

  it('externalizes binary payloads and hydrates them through validated references', async () => {
    const project = projectWithAssets();
    const plan = buildSharedSnapshotAssetPlan(project);
    const payload = createCompactSharedSnapshotPayload(project, plan.assets);
    const serializedPayload = JSON.parse(JSON.stringify(payload));
    const parsed = parseSharedSnapshotPayload(
      serializedPayload,
      COMPACT_SHARED_SNAPSHOT_PAYLOAD_VERSION
    );

    expect(plan.uploads).toHaveLength(4);
    expect(JSON.stringify(serializedPayload).length).toBeLessThan(JSON.stringify(project).length / 2);
    expect(parsed.project.facadeElevationDrawings?.[0].dataUrl).toBe('');
    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].photos[0]).toMatchObject({
      imageData: '',
      thumbnail: undefined,
    });
    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].files[0].data).toBe('');
    expect(getSharedSnapshotProjectName(serializedPayload)).toBe('Compact shared project');

    const payloadByPath = new Map(plan.uploads.map((upload) => [upload.reference.path, upload.dataUrl]));
    await hydrateSharedSnapshotAssetsWithResolver(
      parsed.project,
      parsed.assets,
      'shared-project-1',
      async (reference) => payloadByPath.get(reference.path) ?? Promise.reject(new Error('Missing test asset'))
    );

    expect(parsed.project.facadeElevationDrawings?.[0].dataUrl).toBe(drawingData);
    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].photos[0]).toMatchObject({
      imageData: photoData,
      thumbnail: thumbnailData,
    });
    expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].files[0].data).toBe(fileData);
  });

  it('skips uploads already represented by active attachment metadata', () => {
    const project = projectWithAssets();
    const firstPlan = buildSharedSnapshotAssetPlan(project);
    const existingMetadata: SharedAttachmentMetadataRow[] = firstPlan.uploads.map((upload) => ({
      storage_bucket: upload.reference.bucket,
      storage_path: upload.reference.path,
      file_name: upload.fileName,
      mime_type: upload.reference.mimeType,
      size_bytes: upload.reference.sizeBytes,
      deleted_at: null,
      updated_at: timestamp.toISOString(),
    }));

    expect(buildSharedSnapshotAssetPlan(project, existingMetadata).uploads).toHaveLength(0);
  });

  it('rejects attachment references outside the linked shared project', async () => {
    const project = projectWithAssets();
    const plan = buildSharedSnapshotAssetPlan(project);
    plan.assets.photos['photo-1'].image.path = 'another-project/photo-1/photo.jpg';

    await expect(hydrateSharedSnapshotAssetsWithResolver(
      project,
      plan.assets,
      'shared-project-1',
      async () => photoData
    )).rejects.toThrow('outside this shared project');
  });

  it('rejects traversal segments inside an otherwise valid project prefix', async () => {
    const project = projectWithAssets();
    const plan = buildSharedSnapshotAssetPlan(project);
    plan.assets.photos['photo-1'].image.path = 'shared-project-1/../another-project/photo.jpg';

    await expect(hydrateSharedSnapshotAssetsWithResolver(
      project,
      plan.assets,
      'shared-project-1',
      async () => photoData
    )).rejects.toThrow('outside this shared project');
  });
});
