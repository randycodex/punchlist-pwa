'use client';

import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useSyncExternalStore } from 'react';

const subscribeRecoveryTimes = () => () => {};

function readRecoveryTimes() {
  try {
    const settings = JSON.parse(window.localStorage.getItem('punchlist:app-settings') ?? '{}') as { lastSyncAt?: string };
    return `${window.localStorage.getItem('punchlist:last-confirmed-local-save') ?? ''}|${settings.lastSyncAt ?? ''}`;
  } catch {
    return '|';
  }
}

function readableTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

function getErrorReference(error?: Error & { digest?: string }) {
  if (error?.digest) return error.digest;
  if (!error) return 'screen-load';
  let hash = 2166136261;
  for (const character of `${error.name}:${error.message}`) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return `CLIENT-${(hash >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export default function AppErrorFallback({
  title = 'Punchlist needs to recover',
  message = 'This screen could not load. Try again, then check your latest work and sync status before continuing.',
  onRetry,
  error,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  error?: Error & { digest?: string };
}) {
  const reference = getErrorReference(error);
  const recoveryTimes = useSyncExternalStore(subscribeRecoveryTimes, readRecoveryTimes, () => '');
  const [localSaveAt, fullSyncAt] = recoveryTimes.split('|');
  const copyDetails = () => {
    if (!error || typeof navigator === 'undefined') return;
    const details = [
      'Punchlist screen error',
      `Reference: ${reference}`,
      `Page: ${window.location.pathname}`,
      `Time: ${new Date().toISOString()}`,
      `Message: ${error.message}`,
    ].join('\n');
    void navigator.clipboard?.writeText(details);
  };
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--background)] px-5 py-10 text-[var(--foreground)]">
      <section className="card-surface w-full max-w-md rounded-[2rem] p-7 text-center sm:p-9" role="alert">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-gray-950 dark:text-white">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{message}</p>
        {error && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Reference: {reference}</p>}
        {recoveryTimes && (
          <div className="mt-4 rounded-xl soft-control p-3 text-left text-xs leading-5 text-gray-600 dark:text-gray-300">
            <p>Last confirmed device save: {readableTime(localSaveAt) ?? 'time unavailable'}</p>
            <p>Last completed full sync: {readableTime(fullSyncAt) ?? 'time unavailable'}</p>
            <p className="mt-1">These times do not confirm that your latest change reached the team. Check the project before editing again.</p>
          </div>
        )}
        <div className="mt-6 grid gap-2 sm:grid-cols-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex h-11 items-center justify-center gap-2 rounded-[1rem] bg-gray-950 px-4 text-sm font-semibold text-white transition hover:bg-black dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100"
            >
              <RefreshCw className="h-4 w-4" />
              Try again
            </button>
          )}
          <Link
            href="/"
            className="flex h-11 items-center justify-center rounded-[1rem] soft-control px-4 text-sm font-semibold text-gray-800 transition hover:bg-white dark:text-gray-100 dark:hover:bg-white/[0.09]"
          >
            Go to projects
          </Link>
        </div>
        {error && <button type="button" onClick={copyDetails} className="mt-3 text-sm font-medium underline underline-offset-4">Copy error details</button>}
      </section>
    </main>
  );
}
