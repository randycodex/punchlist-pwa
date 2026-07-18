import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const globalStyles = readFileSync(
  resolve(process.cwd(), 'src/app/globals.css'),
  'utf8'
);
const appPages = [
  'src/app/page.tsx',
  'src/app/project/[id]/page.tsx',
  'src/app/project/[id]/area/[areaId]/page.tsx',
].map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'));
const persistentTopBar = readFileSync(
  resolve(process.cwd(), 'src/components/PersistentTopBar.tsx'),
  'utf8'
);

describe('mobile top-bar safe area', () => {
  it('uses the top-bar surface token behind the translucent iOS status bar', () => {
    expect(globalStyles).toMatch(
      /\.persistent-top-bar::before\s*\{[\s\S]*?height:\s*env\(safe-area-inset-top\);[\s\S]*?background-color:\s*var\(--top-bar-surface\);/
    );
  });

  it('keeps the wrapper transparent so the rounded top bar remains visible', () => {
    expect(globalStyles).toMatch(
      /\.persistent-top-bar\s*\{[\s\S]*?background-color:\s*transparent\s*!important;/
    );
  });

  it('fills the app shell instead of leaving a second mobile viewport gap', () => {
    for (const page of appPages) {
      expect(page).toContain('className="app-page flex h-full flex-col overflow-hidden"');
      expect(page).not.toContain('app-page h-[calc(100dvh-env(safe-area-inset-top)-3.5rem)]');
    }
  });

  it('extends the mobile menu through the bottom inset and allows touch scrolling', () => {
    expect(globalStyles).toMatch(
      /\.app-menu-drawer\.menu-surface\s*\{[\s\S]*?bottom:\s*calc\(-1 \* env\(safe-area-inset-bottom\)\);[\s\S]*?height:\s*auto;/
    );
    expect(persistentTopBar).toContain(
      'app-menu-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y'
    );
    expect(persistentTopBar).not.toContain('min-h-0 flex-1 touch-none overflow-hidden');
  });
});
