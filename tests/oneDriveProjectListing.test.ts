import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProjectFileMetadataInFolder, listProjectFiles, uploadProjectFile } from '@/lib/oneDrive';

afterEach(() => vi.unstubAllGlobals());

describe('OneDrive project listing', () => {
  it('keeps device snapshots out of personal restore listings', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = decodeURI(String(input));
      if (url.includes('PunchList:/children')) {
        return Response.json({ value: [{ id: 'team-backups', name: 'Team Backups', folder: {} }] });
      }
      if (url.includes('PunchList/Team Backups:/children')) {
        // Even a JSON copied directly into the reserved container is excluded.
        return Response.json({ value: [{ id: 'snapshot', name: 'snapshot.json' }] });
      }
      if (url.includes(':/children')) return Response.json({ value: [] });
      return Response.json({ id: 'folder', folder: {} });
    }));
    expect(await listProjectFiles('team-listing-test-token')).toEqual([]);
  });

  it('creates snapshots without replacement and reads their exact nested path', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = decodeURI(String(input));
      if (options?.method === 'PUT') return Response.json({ id: 'snapshot', name: 'snapshot.json' });
      if (url.includes('snapshot.json')) return Response.json({ id: 'snapshot', name: 'snapshot.json' });
      return Response.json({ id: 'folder', folder: {} });
    });
    vi.stubGlobal('fetch', fetchMock);
    const folder = 'Team Backups/team-id/device-id/Alafia';
    await uploadProjectFile('snapshot-api-test-token', folder, 'snapshot.json', '{"backup":true}', false, undefined, 'fail');
    const write = fetchMock.mock.calls.find((call) => String(call[0]).includes(':/content'));
    expect(decodeURI(String(write?.[0])))
      .toBe(`https://graph.microsoft.com/v1.0/me/drive/root:/PunchList/${folder}/snapshot.json:/content?@microsoft.graph.conflictBehavior=fail`);
    expect(write?.[1]).toMatchObject({ method: 'PUT', body: '{"backup":true}' });
    await expect(getProjectFileMetadataInFolder('snapshot-api-test-token', folder, 'snapshot.json'))
      .resolves.toMatchObject({ id: 'snapshot' });
    expect(decodeURI(new URL(String(fetchMock.mock.calls.at(-1)?.[0])).pathname))
      .toBe(`/v1.0/me/drive/root:/PunchList/${folder}/snapshot.json`);
  });

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
