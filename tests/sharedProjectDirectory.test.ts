import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Project } from '@/types';
import { findPreferredLocalSharedProject } from '@/features/collaboration/sharedProjectDirectoryLocal';

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
    expect(homePage).toContain('const isInTrash = Boolean(localProject?.deletedAt);');
    expect(homePage).toContain("isInTrash ? 'In Trash — restore from Trash'");
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
