'use client';

import { useId, useState } from 'react';
import AppConfirmDialog from '@/components/AppConfirmDialog';
import { getDisconnectProjectProgress, type DisconnectProjectStage } from './disconnectProject';

type Props = {
  projectName: string;
  isOwner: boolean;
  localOnly: boolean;
  busy: boolean;
  stage: DisconnectProjectStage | null;
  errorMessage?: string;
  onCancel: () => void;
  onConfirm: (saveBackup: boolean) => void;
};

export default function DisconnectProjectDialog({
  projectName, isOwner, localOnly, busy, stage, errorMessage, onCancel, onConfirm,
}: Props) {
  const [saveBackup, setSaveBackup] = useState(true);
  const descriptionId = useId();
  const progress = getDisconnectProjectProgress(stage, isOwner);

  return (
    <AppConfirmDialog
      title={localOnly ? 'Keep Local Copy' : isOwner ? 'Stop Sharing' : 'Leave Shared Project'}
      message={localOnly
        ? `“${projectName}” is no longer available to this account as a shared project.\n\nDisconnect this device’s copy from collaboration? Your local inspection data will stay on this device.`
        : isOwner
          ? `Stop sharing “${projectName}”?\n\nThis will archive the shared project for everyone and disconnect this device’s local copy. Your local inspection data will stay on this device.`
          : `Leave “${projectName}”?\n\nThis will remove your membership and disconnect this device’s local copy. Other members will keep access. Your saved photos, notes, and unsynced work will stay on this device, but will stop uploading to the team.`}
      confirmLabel={busy
        ? progress?.label ?? 'Preparing…'
        : localOnly ? 'Keep Local Copy' : isOwner ? 'Stop Sharing' : 'Leave Project'}
      danger
      busy={busy}
      statusMessage={progress?.message}
      errorMessage={errorMessage}
      onCancel={onCancel}
      onConfirm={() => onConfirm(saveBackup)}
    >
      {!localOnly && (
        <div className="mt-4 rounded-2xl border border-gray-200 p-3 dark:border-white/10">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-gray-900 dark:text-white">
            <input
              type="checkbox"
              checked={saveBackup}
              disabled={busy}
              onChange={(event) => setSaveBackup(event.target.checked)}
              aria-describedby={descriptionId}
              className="h-5 w-5 shrink-0 accent-[var(--accent)]"
            />
            Save a shared backup first
          </label>
          <p id={descriptionId} className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">
            {saveBackup
              ? 'Recommended. Save a new copy of this device’s saved inspection before changing access. This may take a few minutes.'
              : 'No new shared backup will be saved. Unsynced work will remain on this device and will not be uploaded to the team. Work not backed up elsewhere could be lost if this browser’s data is cleared or this device is lost.'}
          </p>
        </div>
      )}
    </AppConfirmDialog>
  );
}
