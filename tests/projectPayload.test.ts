import { describe, expect, it } from 'vitest';
import {
  ProjectPayloadValidationError,
  parseProjectPayload,
  serializeProjectPayload,
} from '@/lib/projectPayload';
import type { Project } from '@/types';

const timestamp = new Date('2026-01-01T00:00:00.000Z');

function validProject(): Project {
  return {
    id: 'project-1',
    projectName: 'Validated project',
    address: '',
    date: timestamp,
    inspector: '',
    gcName: '',
    gcSignoff: '',
    areas: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('project payload validation', () => {
  it('accepts legacy unwrapped project JSON and revives dates', () => {
    const parsed = parseProjectPayload(JSON.parse(JSON.stringify(validProject())));
    expect(parsed.id).toBe('project-1');
    expect(parsed.updatedAt).toBeInstanceOf(Date);
    expect(parsed.updatedAt.toISOString()).toBe(timestamp.toISOString());
  });

  it('round-trips the versioned OneDrive envelope', () => {
    const detachedAt = new Date('2026-01-02T00:00:00.000Z');
    const parsed = parseProjectPayload(JSON.parse(serializeProjectPayload({
      ...validProject(),
      detachedSharedProjectId: 'shared-project-1',
      detachedSharedProjectAt: detachedAt,
      detachedSharedSnapshotPublishedAt: timestamp,
    })));
    expect(parsed.projectName).toBe('Validated project');
    expect(parsed.detachedSharedProjectId).toBe('shared-project-1');
    expect(parsed.detachedSharedProjectAt).toEqual(detachedAt);
    expect(parsed.detachedSharedSnapshotPublishedAt).toEqual(timestamp);
  });

  it('revives shared baseline, area revision metadata, and purge markers', () => {
    const project = validProject();
    project.sharedBaselinePublishedAt = timestamp;
    project.areas = [{
      id: 'area-1',
      projectId: project.id,
      sharedVersion: 7,
      sharedPublishedAt: timestamp,
      name: 'Area',
      sortOrder: 0,
      isComplete: false,
      notes: '',
      locations: [],
      deletedAt: timestamp,
      purgedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];

    const parsed = parseProjectPayload(JSON.parse(JSON.stringify(project)));
    expect(parsed.sharedBaselinePublishedAt).toEqual(timestamp);
    expect(parsed.areas[0]).toMatchObject({
      sharedVersion: 7,
      sharedPublishedAt: timestamp,
      deletedAt: timestamp,
      purgedAt: timestamp,
    });
  });

  it('rejects unsupported versions before touching local data', () => {
    expect(() =>
      parseProjectPayload({ payloadVersion: 99, project: validProject() })
    ).toThrow(ProjectPayloadValidationError);
  });

  it('rejects malformed nested data with a useful field path', () => {
    const malformed = {
      ...validProject(),
      areas: [
        {
          id: 'area-1',
          projectId: 'project-1',
          name: 'Area',
          sortOrder: 0,
          isComplete: false,
          notes: '',
          locations: 'not-an-array',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };

    expect(() => parseProjectPayload(malformed)).toThrow('project.areas[0].locations must be an array');
  });

  it('rejects invalid dates', () => {
    expect(() => parseProjectPayload({ ...validProject(), updatedAt: 'not-a-date' })).toThrow(
      'project.updatedAt must be a valid date'
    );
  });
});
