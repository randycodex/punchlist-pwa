'use client';

import { useEffect, useRef, useState } from 'react';
import { getProject } from '@/lib/db';
import { getCollaborationErrorMessage, getSharedProjectBackupPreview, type CollaborationSnapshotBackup } from '@/lib/collaboration';
import type { Project } from '@/types';
import { formatTeamBackupImpact, summarizeTeamBackupImpact, type TeamBackupImpact } from '@/features/projects/teamBackupImpact';

type Props = {
  backup: CollaborationSnapshotBackup;
  label: string;
  project: Project;
  restoreBusy: boolean;
  isRestoring: boolean;
  onRestore: (publishAfterRestore: boolean, impact: TeamBackupImpact) => void;
};

export default function TeamBackupCard({ backup, label, project, restoreBusy, isRestoring, onRestore }: Props) {
  const [showComparison, setShowComparison] = useState(false);
  const [impact, setImpact] = useState<TeamBackupImpact | null>(null);
  const [loadingAction, setLoadingAction] = useState<'preview' | 'restore' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    requestId.current += 1;
    setImpact(null);
    setShowComparison(false);
    setLoadingAction(null);
    setError(null);
  }, [project]);

  async function compare(action: 'preview' | 'restore' | 'publish') {
    if (loadingAction || restoreBusy) return;
    const thisRequest = ++requestId.current;
    setShowComparison(true);
    setLoadingAction(action);
    setError(null);
    try {
      const backupContents = await getSharedProjectBackupPreview(project, backup.id);
      const current = await getProject(project.id);
      if (!current) throw new Error('Could not load the current project on this device.');
      if (current.sharedProjectId !== project.sharedProjectId) throw new Error('This device is no longer linked to the same team project.');
      if (!mounted.current || thisRequest !== requestId.current) return;
      const nextImpact = summarizeTeamBackupImpact(current, backupContents);
      setImpact(nextImpact);
      if (action !== 'preview') onRestore(action === 'publish', nextImpact);
    } catch (reason) {
      if (mounted.current && thisRequest === requestId.current) setError(getCollaborationErrorMessage(reason, 'Could not compare this backup. Please try again.'));
    } finally {
      if (mounted.current && thisRequest === requestId.current) setLoadingAction(null);
    }
  }

  return (
    <div className="rounded-[1.25rem] soft-control p-4 dark:bg-white/[0.04]">
      <div className="text-sm font-semibold text-gray-900 dark:text-white">{label}</div>
      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{backup.capturedAt.toLocaleString()}</div>
      {backup.storageLocation === 'device' && (
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {backup.uploadPending ? 'Saved on this device. Team backup upload pending.' : 'Saved on this device and uploaded to the team.'}
        </div>
      )}
      {backup.note && <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">{backup.note}</div>}
      <div className="mt-3 flex flex-wrap gap-3 text-xs">
        <button type="button" className="font-medium underline underline-offset-2 text-gray-700 dark:text-gray-200"
          onClick={() => showComparison ? setShowComparison(false) : void compare('preview')}
          disabled={!!loadingAction || restoreBusy}
          aria-expanded={showComparison}
        >
          {showComparison ? 'Hide comparison' : 'See what changes'}
        </button>
        {showComparison && !loadingAction && (
          <button type="button" className="font-medium underline underline-offset-2 text-gray-500 dark:text-gray-400"
            onClick={() => void compare('preview')} disabled={restoreBusy}>Recheck</button>
        )}
      </div>
      {showComparison && (
        <div className="mt-3 rounded-xl bg-black/[0.04] p-3 text-xs leading-5 text-gray-700 dark:bg-white/[0.06] dark:text-gray-300" role="status">
          {loadingAction && <p>Comparing this backup with the project on this device…</p>}
          {!loadingAction && error && <p className="text-red-700 dark:text-red-300">{error}</p>}
          {!loadingAction && !error && impact && (
            <>
              <p className="mb-2 font-semibold">Compared with this device now</p>
              <ul className="list-disc space-y-1 pl-4">
                {formatTeamBackupImpact(impact).map((line) => <li key={line}>{line}</li>)}
              </ul>
              <p className="mt-2 text-gray-500 dark:text-gray-400">This highlights major differences from this device, not the current team version. Restoring also replaces project details and inspection data that may not be listed here.</p>
            </>
          )}
        </div>
      )}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => void compare('restore')} disabled={restoreBusy || !!loadingAction}
          className="soft-control rounded-2xl px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-white disabled:cursor-default disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/[0.08]">
          {isRestoring ? 'Restoring…' : loadingAction === 'restore' ? 'Reviewing…' : 'Restore on this device'}
        </button>
        <button type="button" onClick={() => void compare('publish')} disabled={restoreBusy || !!loadingAction}
          className="rounded-2xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-black disabled:cursor-default disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
          {loadingAction === 'publish' ? 'Reviewing…' : 'Restore + publish to team'}
        </button>
      </div>
    </div>
  );
}
