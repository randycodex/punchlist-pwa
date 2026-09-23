import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types';
import { findPreferredLocalSharedProject, getInactiveLocalSharedProjects, getSharedProjectDirectoryLocalStatus } from '@/features/collaboration/sharedProjectDirectoryLocal';

const homePage = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf8');
const persistentTopBar = readFileSync(
  resolve(process.cwd(), 'src/components/PersistentTopBar.tsx'),
  'utf8'
);

describe('shared project directory local status', () => {
  function project(id: string, deletedAt?: Date): Project {
    const date = new Date('2026-09-23T12:00:00Z');
    return {
      id, projectName: 'Team project', address: '', date, inspector: '', gcName: '', gcSignoff: '',
      areas: [], createdAt: date, updatedAt: date, sharedProjectId: 'shared-1', deletedAt,
    };
  }

  it('chooses an active copy even if a trashed copy appears first', () => {
    const trashed = project('older-copy', new Date('2026-09-23T13:00:00Z'));
    const active = project('active-copy');
    expect(findPreferredLocalSharedProject([trashed, active], {
      projectId: 'shared-1', localProjectId: trashed.id,
    })).toBe(active);
  });

  it('identifies a matching local project that is currently in Trash', () => {
    expect(getSharedProjectDirectoryLocalStatus(project('older-copy', new Date()), {
      projectId: 'shared-1', localProjectId: 'older-copy',
    })).toEqual({ isLinkedOnDevice: true, isInTrash: true, needsReconnect: false });
    expect(homePage).toContain("isInTrash ? 'In Trash — restore from Trash'");
  });

  it('does not call an unlinked local copy available to the team', () => {
    const local = project('owner-copy');
    delete local.sharedProjectId;
    expect(getSharedProjectDirectoryLocalStatus(local, {
      projectId: 'shared-1', localProjectId: local.id,
    })).toEqual({ isLinkedOnDevice: false, isInTrash: false, needsReconnect: true });
    expect(homePage).toContain("'Connect existing copy'");
  });

  it('reports an active local team copy missing from the account directory once', () => {
    const first = project('first-copy');
    const second = project('second-copy');
    const trashed = project('old-trash', new Date());
    const activeElsewhere = project('other-team');
    activeElsewhere.sharedProjectId = 'shared-2';

    expect(getInactiveLocalSharedProjects([first, second, trashed, activeElsewhere], [
      { projectId: 'shared-2' },
    ])).toEqual([first]);
  });

  it('opens Trash when the shared project local copy is trashed', () => {
    expect(homePage).toContain('if (isInTrash) {');
    expect(homePage).toContain('openTrashFromSharedProjectDirectory();');
    expect(homePage).toContain('setShowTrash(true);');
    expect(homePage).toContain("new CustomEvent('punchlist-close-home-menu-on-mobile')");
    expect(persistentTopBar).toContain(
      "window.addEventListener('punchlist-close-home-menu-on-mobile', handleCloseHomeMenuOnMobile);"
    );
  });
});
