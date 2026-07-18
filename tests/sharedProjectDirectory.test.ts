import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const homePage = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf8');
const persistentTopBar = readFileSync(
  resolve(process.cwd(), 'src/components/PersistentTopBar.tsx'),
  'utf8'
);

describe('shared project directory local status', () => {
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
