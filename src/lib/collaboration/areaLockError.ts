/** Locks belong to an account; merging newer data cannot release another account's lock. */
export function isAreaLockError(message: string | null | undefined) {
  const text = (message ?? '').toLowerCase();
  return text.includes('locked by another user')
    || text.includes('locked by another device')
    || text.includes('another member is editing')
    || text.includes('lock belongs to another device')
    || text.includes('lock belongs to another account');
}
