'use client';

import { Loader2 } from 'lucide-react';
import type { CollaborationHealthCheck, CollaborationHealthReport } from '@/lib/collaboration';

type CollaborationHealthDialogProps = {
  report: CollaborationHealthReport | null;
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
};

function statusClasses(status: CollaborationHealthCheck['status']) {
  if (status === 'ok') {
    return 'bg-green-500/10 text-green-700 dark:bg-green-400/10 dark:text-green-300';
  }
  if (status === 'warning') {
    return 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300';
  }
  return 'bg-red-500/10 text-red-700 dark:bg-red-400/10 dark:text-red-300';
}

function statusLabel(status: CollaborationHealthCheck['status']) {
  if (status === 'ok') return 'OK';
  if (status === 'warning') return 'Check';
  return 'Missing';
}

export default function CollaborationHealthDialog({
  report,
  loading,
  onClose,
  onRefresh,
}: CollaborationHealthDialogProps) {
  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="modal-panel max-h-[84dvh] w-full max-w-md overflow-y-auto rounded-[1.9rem] p-6">
        <h2 className="mb-1 text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">
          Collaboration Health
        </h2>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">
          Checks the shared-project database tables, functions, auth session, and runtime config.
        </p>

        {loading ? (
          <div className="flex items-center gap-3 rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Running checks...
          </div>
        ) : report ? (
          <div className="space-y-3">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Checked {report.checkedAt.toLocaleString()}
            </div>
            {report.checks.map((check) => (
              <div key={check.key} className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 p-4 dark:bg-white/[0.04]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                      {check.label}
                    </div>
                    <div className="mt-1 break-words text-xs leading-5 text-gray-500 dark:text-gray-400">
                      {check.message}
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusClasses(check.status)}`}>
                    {statusLabel(check.status)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-[1.25rem] border border-[var(--surface-border)] bg-white/70 px-4 py-5 text-sm text-gray-500 dark:bg-white/[0.04] dark:text-gray-400">
            No checks have run yet.
          </div>
        )}

        <div className="mt-6 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            Done
          </button>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
          >
            Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
