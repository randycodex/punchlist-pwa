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

  it('keeps the bulk area release action in the primary Team menu', () => {
    const releaseActionIndex = persistentTopBar.indexOf("dispatchHomeAction('release-my-area-locks')");
    const moreToggleIndex = persistentTopBar.indexOf('setShowTeamMore((current) => !current)');

    expect(releaseActionIndex).toBeGreaterThan(-1);
    expect(releaseActionIndex).toBeLessThan(moreToggleIndex);
    expect(persistentTopBar).toContain("'Release Areas'");
    expect(persistentTopBar.match(/dispatchHomeAction\('release-my-area-locks'\)/g)).toHaveLength(1);
  });
});
