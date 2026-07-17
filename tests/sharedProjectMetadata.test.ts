import { describe, expect, it } from 'vitest';
import { createProject } from '@/lib/db';
import { ProjectPayloadValidationError } from '@/lib/projectPayload';
import {
  applySharedProjectMetadataSnapshot,
  createSharedProjectMetadataPayload,
} from '@/lib/collaboration/sharedProjectMetadata';

describe('shared project metadata payloads', () => {
  it('serializes only bounded project detail fields', () => {
    const project = createProject('Project details', '123 Main Street', 'Inspector One');
    project.gcName = 'GC One';
    project.facadeLevelStart = 2;
    project.facadeLevelEnd = 12;

    expect(createSharedProjectMetadataPayload(project)).toEqual({
      projectName: 'Project details',
      address: '123 Main Street',
      date: project.date.toISOString(),
      inspector: 'Inspector One',
      gcName: 'GC One',
      gcSignoff: '',
      facadeLevelStart: 2,
      facadeLevelEnd: 12,
    });
  });

  it('rejects permanently invalid metadata before it can enter a retry loop', () => {
    const project = createProject('x'.repeat(201));
    expect(() => createSharedProjectMetadataPayload(project)).toThrow(ProjectPayloadValidationError);
  });

  it('rejects an invalid inspection date before it can enter a retry loop', () => {
    const project = createProject('Project with invalid date');
    project.date = new Date(Number.NaN);

    expect(() => createSharedProjectMetadataPayload(project)).toThrow(ProjectPayloadValidationError);
  });

  it('rejects unsupported remote fields instead of merging arbitrary data into a project', () => {
    const project = createProject('Local project');
    expect(() => applySharedProjectMetadataSnapshot(project, {
      project_id: 'shared-project-1',
      metadata_payload: {
        projectName: 'Remote project',
        address: '',
        date: project.date.toISOString(),
        inspector: '',
        gcName: '',
        gcSignoff: '',
        facadeLevelStart: null,
        facadeLevelEnd: null,
        areas: [],
      },
      payload_version: 1,
      version: 1,
      published_by_user_id: 'user-1',
      published_at: '2026-07-17T12:00:00.000Z',
    })).toThrow(ProjectPayloadValidationError);
  });
});
