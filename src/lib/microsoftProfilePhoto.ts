const MICROSOFT_PROFILE_PHOTO_URL =
  'https://graph.microsoft.com/v1.0/me/photos/96x96/$value';

export const MAX_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;

function normalizeProfilePhotoMimeType(value: string | null) {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (!normalized || normalized === 'image/jpg') return 'image/jpeg';
  return normalized;
}

export async function fetchMicrosoftProfilePhoto(accessToken: string) {
  const response = await fetch(MICROSOFT_PROFILE_PHOTO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Microsoft profile photo request failed (${response.status}).`);
  }

  const contentType = normalizeProfilePhotoMimeType(response.headers.get('content-type'));
  if (contentType !== 'image/jpeg' && contentType !== 'image/png') {
    throw new Error('Microsoft returned an unsupported profile photo format.');
  }

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PROFILE_PHOTO_BYTES) {
    throw new Error('Microsoft profile photo is larger than 2 MB.');
  }

  return new Blob([bytes], { type: contentType });
}
