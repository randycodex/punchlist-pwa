'use client';

import Link from 'next/link';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export default function AppErrorFallback({
  title = 'Punchlist needs to recover',
  message = 'Your locally saved project data is still on this device. Try loading this screen again.',
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[var(--background)] px-5 py-10 text-[var(--foreground)]">
      <section className="card-surface w-full max-w-md rounded-[2rem] p-7 text-center sm:p-9" role="alert">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-400/10 dark:text-amber-200">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-gray-950 dark:text-white">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">{message}</p>
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
            className="flex h-11 items-center justify-center rounded-[1rem] border border-black/10 bg-white/70 px-4 text-sm font-semibold text-gray-800 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.05] dark:text-gray-100 dark:hover:bg-white/[0.09]"
          >
            Go to projects
          </Link>
        </div>
      </section>
    </main>
  );
}
