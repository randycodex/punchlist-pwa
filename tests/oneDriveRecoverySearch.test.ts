import { afterEach, expect, it, vi } from 'vitest';
import { findOneDriveRecoveryPhotos } from '@/lib/oneDrive';

const photoId = 'a76d98a0-d4f9-4ddc-9eb0-e12627da966e';
const path = '/drives/example/root:/PunchList/Team Backups/team/device/Alafia/photos';
const match = { id: 'file-1', name: `checkpoint_${photoId}.jpg`, size: 100, file: { mimeType: 'image/jpeg' }, parentReference: { path }, webUrl: 'https://example.sharepoint.com/photo.jpg' };
afterEach(() => vi.unstubAllGlobals());

it('finds exact photo filenames in device backups, filters unrelated files and only reads Graph', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: [match,
    { ...match, id: 'other-folder', parentReference: { path: '/drives/example/root:/Private/photos' } },
    { ...match, id: 'thumb', name: `checkpoint_${photoId}_thumb.jpg` },
    { ...match, id: 'wrong', name: 'different.jpg' },
    { ...match, id: 'empty', size: 0 },
  ] })));
  vi.stubGlobal('fetch', fetch);
  expect(await findOneDriveRecoveryPhotos('test-token', [photoId, photoId.toUpperCase()])).toEqual([
    { photoId, id: match.id, name: match.name, folder: 'PunchList/Team Backups/team/device/Alafia/photos', webUrl: match.webUrl },
  ]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain(`/me/drive/root/search(q='${photoId}')`);
  expect(fetch.mock.calls[0][1].method ?? 'GET').toBe('GET');
});

it('reads subsequent pages and preserves safe matches in legacy and trash folders', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/drive/root/search?skipToken=page-2';
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ value: [], '@odata.nextLink': next })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ value: [{ ...match, parentReference: { path: '/drive/root:/PunchList/Trash Bin/old/photos' }, webUrl: 'https://untrusted.example/photo' }] })));
  vi.stubGlobal('fetch', fetch);
  const results = await findOneDriveRecoveryPhotos('test-token', [photoId]);
  expect(results[0]).toMatchObject({ photoId, folder: 'PunchList/Trash Bin/old/photos' });
  expect(results[0].webUrl).toBeUndefined();
  expect(fetch.mock.calls[1][0]).toBe(next);
});

it('rejects a redirected pagination link before sending credentials outside Graph', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: [], '@odata.nextLink': 'https://untrusted.example/search' })));
  vi.stubGlobal('fetch', fetch);
  await expect(findOneDriveRecoveryPhotos('test-token', [photoId])).rejects.toThrow('could not be completed safely');
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('does not report a complete search after an account switch or failed request', async () => {
  let active = true;
  const fetch = vi.fn().mockImplementation(async () => { active = false; return new Response(JSON.stringify({ value: [match] })); });
  vi.stubGlobal('fetch', fetch);
  await expect(findOneDriveRecoveryPhotos({ accessToken: 'test-token', assertActive: () => { if (!active) throw new Error('account changed'); } }, [photoId])).rejects.toThrow('account changed');
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'OneDrive access denied' } }), { status: 403 }));
  await expect(findOneDriveRecoveryPhotos('test-token', [photoId])).rejects.toThrow('OneDrive access denied');
});

it('accepts no matches as a search result and rejects malformed identities without network requests', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: [] })));
  vi.stubGlobal('fetch', fetch);
  expect(await findOneDriveRecoveryPhotos('test-token', [photoId])).toEqual([]);
  await expect(findOneDriveRecoveryPhotos('test-token', ["bad')query"])).rejects.toThrow('could not be checked');
  expect(fetch).toHaveBeenCalledTimes(1);
});
