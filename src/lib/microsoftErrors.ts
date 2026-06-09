function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function isMicrosoftTransientSyncError(error: unknown): boolean {
  const message = extractErrorMessage(error).trim().toLowerCase();
  if (!message) return false;

  return (
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('service unavailable') ||
    message.includes('too many requests') ||
    message.includes('throttled') ||
    message.includes('itemnotfound') ||
    message.includes('item not found') ||
    message.includes('network') ||
    message.includes('failed to fetch') ||
    message.includes('load failed') ||
    message.includes('general exception while processing')
  );
}

export function getMicrosoftErrorMessage(error: unknown, fallback: string): string {
  const rawMessage = extractErrorMessage(error).trim();
  const message = rawMessage.toLowerCase();

  if (!rawMessage) return fallback;

  if (message.includes('aadsts50020') || message.includes('user account') && message.includes('identity provider')) {
    return 'This Microsoft account is not in the UAI tenant. Use a UAI work email.';
  }

  if (message.includes('access_denied')) {
    return 'Microsoft blocked this account from using UAI PUNCHLIST APP. Contact UAI IT.';
  }

  if (message.includes('consent') || message.includes('interaction_required')) {
    return 'Microsoft sign-in needs tenant approval for this account. Contact UAI IT.';
  }

  if (
    message.includes('login required') ||
    message.includes('token') && message.includes('expired') ||
    message.includes('invalid grant') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('insufficient privileges')
  ) {
    return 'Microsoft sign-in expired or lost permission. Please sign in again and retry sync.';
  }

  if (isMicrosoftTransientSyncError(error)) {
    return 'Saved locally. Microsoft is catching up.';
  }

  if (
    message === 'the resource could not be found.' ||
    message === 'resource not found' ||
    message.includes("unable to retrieve user's mysite url") ||
    message.includes('resource not found for the segment') ||
    message.includes('mysite host is not found') ||
    message.includes('unable to retrieve user\'s mysite url')
  ) {
    return 'This user does not have OneDrive ready yet. Ask them to open OneDrive once or contact UAI IT.';
  }

  return `${fallback} ${rawMessage}`;
}

export function getMicrosoftRetryDelayMs(error: unknown): number | null {
  const retryAfterMs =
    typeof error === 'object' && error !== null && 'retryAfterMs' in error
      ? Number((error as { retryAfterMs?: unknown }).retryAfterMs)
      : Number.NaN;

  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return retryAfterMs;
  }

  const message = extractErrorMessage(error).toLowerCase();
  if (
    message.includes('throttled') ||
    message.includes('too many requests') ||
    message.includes('429')
  ) {
    return 60_000;
  }

  if (isMicrosoftTransientSyncError(error)) {
    return 15_000;
  }

  return null;
}

export function formatMicrosoftRetryMessage(delayMs: number) {
  return `Saved locally. Microsoft is catching up. Retrying in about ${Math.ceil(delayMs / 1000)} seconds.`;
}

export function formatMicrosoftManualRetryMessage() {
  return 'Saved locally. OneDrive is still catching up. Wait a moment, then tap Sync again.';
}
