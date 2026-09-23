import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const persistentTopBar = readFileSync(
  resolve(process.cwd(), 'src/components/PersistentTopBar.tsx'),
  'utf8'
);

describe('new device project restoration menu', () => {
  it('hides sorting until at least one active project exists', () => {
    expect(persistentTopBar).toContain('{homeMenuState.hasProjects && (');
  });

  it('offers one sync action for personal and team projects', () => {
    expect(persistentTopBar).toContain("dispatchHomeAction('sync-now')");
    expect(persistentTopBar).toContain('Sync Projects');
    expect(persistentTopBar).not.toContain("dispatchHomeAction('restore-onedrive-backup')");
    expect(persistentTopBar).not.toContain("dispatchHomeAction('publish-shared-project')");
    expect(persistentTopBar).not.toContain("dispatchHomeAction('pull-shared-project')");
    expect(persistentTopBar).not.toContain("dispatchHomeAction('release-my-area-locks')");
  });

  it('offers team-project authentication after Microsoft sign-in', () => {
    expect(persistentTopBar).toContain('collaborationAuth.canUseCollaboration &&');
    expect(persistentTopBar).toContain('onClick={() => void collaborationAuth.signIn()}');
    expect(persistentTopBar).toContain("'Enable Team Projects'");
  });

  it('keeps team management actions available', () => {
    expect(persistentTopBar).toContain("dispatchHomeAction('shared-members')");
    expect(persistentTopBar).toContain("dispatchHomeAction('shared-backups')");
    expect(persistentTopBar).toContain("dispatchHomeAction('disconnect-shared-project')");
    expect(persistentTopBar).not.toContain('showTeamMore');
    expect(persistentTopBar).not.toContain('setShowTeamMore');
  });

  it('does not add a redundant All Projects section on project routes', () => {
    expect(persistentTopBar).not.toContain('All Projects');
    expect(persistentTopBar).not.toContain('(showAuth || projectId)');
  });
});
