import { afterEach, describe, expect, it, vi } from 'vitest';

import { listProjectFiles } from '@/lib/oneDrive';

afterEach(() => vi.unstubAllGlobals());

describe('OneDrive project listing', () => {
  it('limits folder reads and retries a throttled read after Retry-After', async () => {
    let activeFolderReads = 0;
    let maxActiveFolderReads = 0;
    let throttledFolderReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = decodeURI(String(input));
      if (url.includes('Project-') && url.includes(':/children')) {
        activeFolderReads += 1;
        maxActiveFolderReads = Math.max(maxActiveFolderReads, activeFolderReads);
        await new Promise((resolve) => setTimeout(resolve, 1));
        activeFolderReads -= 1;
        if (url.includes('Project-1') && throttledFolderReads++ === 0) {
          return Response.json({ error: { message: 'The request has been throttled' } }, {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        const projectName = url.match(/Project-\d+/)?.[0];
        return Response.json({ value: [{ id: `${projectName}-file`, name: `${projectName}.json` }] });
      }
      if (url.includes('PunchList/projects:/children') || url.includes('Trash Bin:/children')) {
        return Response.json({ value: [] });
      }
      if (url.includes('PunchList:/children')) {
        return Response.json({ value: Array.from({ length: 5 }, (_, index) => ({
          id: `folder-${index + 1}`,
          name: `Project-${index + 1}`,
          folder: { childCount: 1 },
        })) });
      }
      return Response.json({ id: 'folder', name: 'PunchList', folder: { childCount: 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const files = await listProjectFiles('listing-test-token');

    expect(files).toHaveLength(5);
    expect(maxActiveFolderReads).toBeLessThanOrEqual(2);
    expect(throttledFolderReads).toBe(2);
  });
});
