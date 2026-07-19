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
const listSortMenu = readFileSync(
  resolve(process.cwd(), 'src/components/ListSortMenu.tsx'),
  'utf8'
);
const rootLayout = readFileSync(
  resolve(process.cwd(), 'src/app/layout.tsx'),
  'utf8'
);

describe('mobile top-bar safe area', () => {
  it('uses the document canvas and top-bar surface token behind the iOS status bar', () => {
    expect(globalStyles).toMatch(
      /html\s*\{[\s\S]*?background-color:\s*var\(--top-bar-surface\);/
    );
    expect(globalStyles).toMatch(
      /body\s*\{[\s\S]*?background-color:\s*var\(--background\);/
    );
    expect(globalStyles).toMatch(
      /\.persistent-top-bar::before\s*\{[\s\S]*?height:\s*env\(safe-area-inset-top\);[\s\S]*?background-color:\s*var\(--top-bar-surface\);/
    );
  });

  it('lets theme-color control iOS chrome without the broken black-translucent viewport mode', () => {
    expect(rootLayout).not.toContain('statusBarStyle: "black-translucent"');
    expect(rootLayout).toContain('statusBarStyle: "default"');
    expect(rootLayout).toContain('{ media: "(prefers-color-scheme: dark)", color: "#191d22" }');
    expect(rootLayout).toContain('viewportFit: "cover"');
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

  it('keeps the static mobile menu above the reserved bottom system area', () => {
    expect(globalStyles).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.app-menu-drawer\.menu-surface\s*\{[\s\S]*?bottom:\s*0;[\s\S]*?height:\s*auto;[\s\S]*?background:\s*var\(--background\);/
    );
    expect(globalStyles).not.toMatch(
      /@media \(max-width: 767px\)[\s\S]*?html\[data-app-menu-open="true"\] body/
    );
    expect(globalStyles).not.toMatch(
      /@media \(max-width: 767px\)[\s\S]*?html\[data-app-menu-open="true"\] \.app-shell/
    );
    expect(globalStyles).toMatch(
      /\.app-menu-drawer \.app-menu-scroll\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?padding-bottom:\s*max\(calc\(env\(safe-area-inset-bottom\) \+ 1rem\), 4\.75rem\);[\s\S]*?background:\s*var\(--background\);/
    );
    expect(globalStyles).not.toContain('transparent calc(100% - env(safe-area-inset-bottom))');
    expect(persistentTopBar).toContain(
      'app-menu-scroll min-h-0 flex flex-1 flex-col touch-none overflow-hidden px-3 pt-1'
    );
    expect(persistentTopBar).toContain('md:overflow-y-auto md:overscroll-y-contain md:touch-pan-y');
    expect(persistentTopBar).toContain(
      "app-menu-card overflow-hidden rounded-[1.1rem] px-2 py-1 md:px-2.5 md:py-1.5"
    );
    expect(persistentTopBar).toContain("px-1 py-0.5 md:py-1");
    expect(persistentTopBar).toContain("app-menu-group px-1 py-0.5 md:py-1");
    expect(persistentTopBar).toContain("app-menu-list grid grid-cols-2");
    expect(globalStyles).toContain('flex: 1 1 auto;');
    expect(globalStyles).toContain('grid-auto-rows: minmax(2.5rem, 1fr);');
    expect(globalStyles).toMatch(
      /@media \(max-width: 767px\) and \(min-height: 850px\)[\s\S]*?padding-bottom:\s*max\(calc\(env\(safe-area-inset-bottom\) \+ 1rem\), 6rem\);/
    );
    expect(persistentTopBar).not.toContain(
      'app-menu-scroll min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y'
    );
  });

  it('uses pill controls within the extended grouped menu', () => {
    expect(persistentTopBar).toContain("const menuListGridClass = 'app-menu-list grid grid-cols-2 gap-2");
    expect(persistentTopBar).toContain("const menuRowClass = 'flex min-h-10");
    expect(persistentTopBar).toContain('rounded-full bg-black/[0.07]');
    expect(listSortMenu).toContain('grid h-full grid-cols-3 gap-2');
    expect(listSortMenu).toContain('role="group" aria-label="Sort list"');
    expect(listSortMenu).toContain('aria-pressed={isSelected}');
    expect(listSortMenu).toContain('rounded-full');
    expect(globalStyles).toMatch(
      /\.app-menu-card\s*\{[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;/
    );
    expect(globalStyles).not.toContain('--app-menu-card-bg');
    expect(persistentTopBar).not.toContain('app-menu-sort-card');
  });
});
