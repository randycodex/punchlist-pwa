import { describe, expect, it } from 'vitest';
import { getAreaReturnPath } from '@/lib/projectNavigation';

describe('area return navigation', () => {
  it('returns to the main screen when there is only one active project', () => {
    expect(getAreaReturnPath('project-id', true)).toBe('/');
  });

  it('returns to project detail when the main screen contains multiple projects', () => {
    expect(getAreaReturnPath('project-id', false)).toBe('/project/project-id');
  });
});
