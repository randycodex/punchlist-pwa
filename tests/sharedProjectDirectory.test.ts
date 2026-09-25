import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types';
import { findPreferredLocalSharedProject, getInactiveLocalSharedProjects, getSharedProjectDirectoryLocalStatus, planSharedProjectJoin } from '@/features/collaboration/sharedProjectDirectoryLocal';

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

  it('does not treat a personal project with the same ID as the team copy', () => {
    const local = project('owner-copy');
    delete local.sharedProjectId;
    const entry = {
      projectId: 'shared-1', localProjectId: local.id,
    };
    expect(findPreferredLocalSharedProject([local], entry)).toBeUndefined();
    expect(getSharedProjectDirectoryLocalStatus(findPreferredLocalSharedProject([local], entry), entry))
      .toEqual({ isLinkedOnDevice: false, isInTrash: false, needsReconnect: false });
    const plan = planSharedProjectJoin([local], entry.projectId, entry.localProjectId, true);
    expect(plan.reusableProject).toBeUndefined();
    expect(plan.requestedIdAvailable).toBe(false);
    expect(plan.needsExplicitReconnect).toBe(false);
  });

  it('reuses only a detached copy of the same team or an explicit team reconnect', () => {
    const detached = project('old-device-copy');
    delete detached.sharedProjectId;
    detached.detachedSharedProjectId = 'shared-1';
    const otherTeam = project('directory-id');
    otherTeam.sharedProjectId = 'shared-2';
    expect(findPreferredLocalSharedProject([otherTeam, detached], {
      projectId: 'shared-1', localProjectId: otherTeam.id,
    })).toBe(detached);
    const detachedPlan = planSharedProjectJoin([otherTeam, detached], 'shared-1', otherTeam.id);
    expect(detachedPlan.reusableProject).toBe(detached);
    expect(detachedPlan.needsExplicitReconnect).toBe(false);
    const automatic = planSharedProjectJoin([otherTeam], 'shared-1', otherTeam.id);
    expect(automatic.needsExplicitReconnect).toBe(true);
    expect(automatic.reusableProject).toBeUndefined();
    const manual = planSharedProjectJoin([otherTeam], 'shared-1', otherTeam.id, true);
    expect(manual.isReconnecting).toBe(true);
    expect(manual.reusableProject).toBe(otherTeam);
  });

  it('does not reuse an unrelated project ID in Trash', () => {
    const trashedPersonal = project('directory-id', new Date());
    delete trashedPersonal.sharedProjectId;
    const plan = planSharedProjectJoin([trashedPersonal], 'shared-1', trashedPersonal.id);
    expect(plan.reusableProject).toBeUndefined();
    expect(plan.requestedIdAvailable).toBe(false);
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
