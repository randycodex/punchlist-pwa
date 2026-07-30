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

  it('offers an explicit personal backup restore before a local project exists', () => {
    expect(persistentTopBar).toContain(
      "dispatchHomeAction('restore-onedrive-backup')"
    );
    expect(persistentTopBar).toContain('Restore My Backup');
  });

  it('offers team-project authentication after Microsoft sign-in', () => {
    expect(persistentTopBar).toContain('collaborationAuth.canUseCollaboration &&');
    expect(persistentTopBar).toContain('onClick={() => void collaborationAuth.signIn()}');
    expect(persistentTopBar).toContain("'Enable Team Projects'");
  });

  it('keeps all Team actions visible without a More or Less toggle', () => {
    const releaseActionIndex = persistentTopBar.indexOf("dispatchHomeAction('release-my-area-locks')");
    const membersActionIndex = persistentTopBar.indexOf("dispatchHomeAction('shared-members')");

    expect(releaseActionIndex).toBeGreaterThan(-1);
    expect(releaseActionIndex).toBeLessThan(membersActionIndex);
    expect(persistentTopBar).toContain("'Release Areas'");
    expect(persistentTopBar).toContain("dispatchHomeAction('shared-backups')");
    expect(persistentTopBar).toContain("dispatchHomeAction('disconnect-shared-project')");
    expect(persistentTopBar).not.toContain('showTeamMore');
    expect(persistentTopBar).not.toContain('setShowTeamMore');
    expect(persistentTopBar.match(/dispatchHomeAction\('release-my-area-locks'\)/g)).toHaveLength(1);
  });

  it('does not add a redundant All Projects section on project routes', () => {
    expect(persistentTopBar).not.toContain('All Projects');
    expect(persistentTopBar).not.toContain('(showAuth || projectId)');
  });
});
