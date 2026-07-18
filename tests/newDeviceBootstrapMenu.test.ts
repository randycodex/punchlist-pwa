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

  it('offers OneDrive sync before a local project exists', () => {
    expect(persistentTopBar).toContain(
      'showAuth && isSignedIn && !homeMenuState.isSingleProject && renderSyncButton()'
    );
  });

  it('offers shared-project authentication after Microsoft sign-in', () => {
    expect(persistentTopBar).toContain('collaborationAuth.canUseCollaboration &&');
    expect(persistentTopBar).toContain('onClick={() => void collaborationAuth.signIn()}');
    expect(persistentTopBar).toContain("'Connect Projects'");
  });
});
