import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchMicrosoftProfilePhoto,
  MAX_PROFILE_PHOTO_BYTES,
} from '@/lib/microsoftProfilePhoto';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Microsoft profile photo', () => {
  it('returns a photo blob for the signed-in account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpg' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const photo = await fetchMicrosoftProfilePhoto('access-token');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me/photos/96x96/$value',
      { headers: { Authorization: 'Bearer access-token' } }
    );
    expect(photo).toBeInstanceOf(Blob);
    expect(photo?.type).toBe('image/jpeg');
    expect(photo?.size).toBe(3);
  });

  it('uses initials when the Microsoft account has no photo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(fetchMicrosoftProfilePhoto('access-token')).resolves.toBeNull();
  });

  it('rejects unexpectedly large profile photos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(MAX_PROFILE_PHOTO_BYTES + 1), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      )
    );

    await expect(fetchMicrosoftProfilePhoto('access-token')).rejects.toThrow(
      'larger than 2 MB'
    );
  });
});
