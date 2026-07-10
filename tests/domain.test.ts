import { describe, expect, it } from 'vitest';
import {
  getCheckpointIssueState,
  getProjectStats,
  isAreaInspectionComplete,
  type Area,
  type Checkpoint,
  type Project,
} from '@/types';

const now = new Date('2026-01-01T00:00:00.000Z');

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: overrides.id ?? 'checkpoint-1',
    itemId: 'item-1',
    name: 'Walls',
    status: 'pending',
    fixStatus: 'pending',
    issueState: 'none',
    comments: '',
    sortOrder: 0,
    photos: [],
    files: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function area(checkpoints: Checkpoint[], overrides: Partial<Area> = {}): Area {
  return {
    id: overrides.id ?? 'area-1',
    projectId: 'project-1',
    name: 'Apartment 1A',
    sortOrder: 0,
    isComplete: false,
    notes: '',
    locations: [
      {
        id: 'location-1',
        areaId: overrides.id ?? 'area-1',
        name: 'Living Room',
        sortOrder: 0,
        items: [
          {
            id: 'item-1',
            locationId: 'location-1',
            name: 'Finishes',
            sortOrder: 0,
            checkpoints,
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('inspection domain state', () => {
  it('normalizes legacy issue states without losing repair progress', () => {
    expect(getCheckpointIssueState(checkpoint({ status: 'ok', issueState: undefined }))).toBe('none');
    expect(getCheckpointIssueState(checkpoint({ status: 'needsReview', fixStatus: 'pending', issueState: undefined }))).toBe('open');
    expect(getCheckpointIssueState(checkpoint({ status: 'needsReview', fixStatus: 'fixed', issueState: undefined }))).toBe('resolved');
    expect(getCheckpointIssueState(checkpoint({ status: 'needsReview', fixStatus: 'verified', issueState: undefined }))).toBe('verified');
  });

  it('only completes an area after every checkpoint has been reviewed', () => {
    expect(isAreaInspectionComplete(area([checkpoint({ status: 'ok' }), checkpoint({ id: 'checkpoint-2' })]))).toBe(false);
    expect(
      isAreaInspectionComplete(
        area([
          checkpoint({ status: 'ok' }),
          checkpoint({ id: 'checkpoint-2', status: 'needsReview', issueState: 'open' }),
        ])
      )
    ).toBe(true);
  });

  it('excludes soft-deleted areas from project statistics', () => {
    const project: Project = {
      id: 'project-1',
      projectName: 'Test project',
      address: '',
      date: now,
      inspector: '',
      gcName: '',
      gcSignoff: '',
      areas: [
        area([checkpoint({ status: 'ok' })]),
        area([checkpoint({ id: 'checkpoint-2', status: 'needsReview', issueState: 'open' })], {
          id: 'area-2',
          deletedAt: now,
        }),
      ],
      createdAt: now,
      updatedAt: now,
    };

    expect(getProjectStats(project)).toEqual({ total: 1, ok: 1, issues: 0, areas: 1 });
  });
});
