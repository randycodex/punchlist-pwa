const OWNER = 'punchlist:legacy-data-owner';
const LAST = 'punchlist:last-data-namespace';
let namespace: string | undefined;
let accountEmail: string | null = null;

/** Select once before mounting the workspace; switching accounts requires reload. */
export function configureLocalAccount(accountId: string | null, email: string | null, rememberedAccountId: string | null) {
  let next = '';
  try {
    const storage = globalThis.localStorage;
    let legacyOwner = storage?.getItem(OWNER);
    if (!legacyOwner && (rememberedAccountId || accountId)) {
      // Preserve pre-account offline inspections when their first owner signs in.
      legacyOwner = rememberedAccountId || accountId;
      storage?.setItem(OWNER, legacyOwner!);
    }
    next = accountId
      ? accountId === legacyOwner ? '' : encodeURIComponent(accountId)
      : storage?.getItem(LAST) ?? '';
    if (namespace !== undefined && namespace !== next) return false;
    storage?.setItem(LAST, next);
  } catch {
    // Storage restrictions must not assign an unknown legacy workspace to a new account.
    next = accountId ? encodeURIComponent(accountId) : '';
    if (namespace !== undefined && namespace !== next) return false;
  }
  namespace = next;
  accountEmail = email?.trim().toLowerCase() ?? null;
  return true;
}

export function localAccountKey(base: string): string {
  return namespace ? `${base}:${namespace}` : base;
}

export function assertLocalAccountEmail(email: string | undefined) {
  if (namespace !== undefined && (!accountEmail || email?.trim().toLowerCase() !== accountEmail)) {
    throw new Error('The team account changed. Reopen the app with the account that owns this local workspace before syncing.');
  }
}
