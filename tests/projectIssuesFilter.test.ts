import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const persistentTopBar = readFileSync(
  resolve(process.cwd(), 'src/components/PersistentTopBar.tsx'),
  'utf8'
);
const homePage = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf8');
const projectPage = readFileSync(
  resolve(process.cwd(), 'src/app/project/[id]/page.tsx'),
  'utf8'
);

describe('project Issues filter', () => {
  it('places an Issues toggle beside the project area-group control', () => {
    expect(persistentTopBar).toContain("dispatchHomeAction('toggle-area-issues')");
    expect(persistentTopBar).toContain("'right-12'");
    expect(persistentTopBar).toContain('Show only areas with issues');
    expect(persistentTopBar).toContain('Show all areas');
  });

  it.each([homePage, projectPage])('filters visible areas to positive issue counts', (source) => {
    expect(source).toContain("detail.action === 'toggle-area-issues'");
    expect(source).toContain('(areaMetrics.get(area.id)?.stats.issues ?? 0) > 0');
    expect(source).toContain('showOnlyAreaIssues');
  });
});
