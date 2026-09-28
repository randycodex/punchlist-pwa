/** Locks need their owning device to finish; merging newer data cannot remove them. */
export function isAreaLockError(message: string | null | undefined) {
  const text = (message ?? '').toLowerCase();
  return text.includes('locked by another user')
    || text.includes('locked by another device')
    || text.includes('another member is editing')
    || text.includes('lock belongs to another device');
}
