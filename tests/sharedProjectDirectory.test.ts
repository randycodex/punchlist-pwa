import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const homePage = readFileSync(resolve(process.cwd(), 'src/app/page.tsx'), 'utf8');

describe('shared project directory local status', () => {
  it('identifies a matching local project that is currently in Trash', () => {
    expect(homePage).toContain('const isInTrash = Boolean(localProject?.deletedAt);');
    expect(homePage).toContain("isInTrash ? 'In Trash — restore from Trash'");
  });
});
