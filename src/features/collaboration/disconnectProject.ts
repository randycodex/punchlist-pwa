import type { Project } from '@/types';
import { detachSavedSharedProject, getProject } from '@/lib/db';
import { captureSharedProjectBackup } from '@/lib/collaboration/sharedProjectSnapshots';
import { disconnectSharedProject, getCollaborationErrorMessage } from '@/lib/collaboration/sharedProjects';
import { withCollaborationTimeout } from '@/lib/collaboration/request';
import { localAccountKey } from '@/lib/localAccount';

export type DisconnectProjectStage = 'loading' | 'backup' | 'disconnect' | 'local';
// Includes preparation plus the existing three 90-second backup attempts.
export const DISCONNECT_BACKUP_TIMEOUT_MS = 5 * 60_000;

export function getDisconnectProjectProgress(stage: DisconnectProjectStage | null, isOwner = false) {
  switch (stage) {
    case 'loading': return { label: 'Preparing…', message: 'Loading your saved project before continuing.' };
    case 'backup': return { label: 'Saving backup…', message: 'Saving a shared backup before changing your access. Large projects or slow connections can take a few minutes. Keep this tab open.' };
    case 'disconnect': return { label: isOwner ? 'Stopping sharing…' : 'Leaving project…', message: 'Waiting for the team service to confirm the access change.' };
    case 'local': return { label: 'Keeping local copy…', message: 'Keeping your saved inspection data on this device.' };
    default: return undefined;
  }
}

export class DisconnectProjectError extends Error {
  constructor(readonly stage: DisconnectProjectStage, cause: unknown) {
    const detail = getCollaborationErrorMessage(cause);
    const timeout = /timeout|timed out|took too long|\b504\b/i.test(detail);
    const preserved = 'Your saved photos and unsynced work remain on this device.';
    const message = stage === 'backup'
      ? `${timeout ? 'Saving the shared backup timed out.' : 'The shared backup could not be confirmed.'} We stopped before requesting any access change. ${preserved}\n\n${timeout ? 'Check your connection and try again. The backup is still required before leaving.' : detail}`
      : stage === 'disconnect'
        ? `${timeout ? 'The team service timed out while confirming the access change.' : 'The access change could not be confirmed.'} Your access may already have changed. Your local copy and pending uploads were not changed. Check Team Projects before trying again.\n\n${detail}`
        : stage === 'local'
          ? `The local disconnect could not be completed. ${preserved} Check Team Projects before trying again.\n\n${detail}`
          : `The saved project could not be loaded. No access change was requested. ${preserved}\n\n${detail}`;
    super(message, { cause });
    this.name = 'DisconnectProjectError';
  }
}

export async function disconnectProjectAccess(sharedProjectId: string) {
  const controller = new AbortController();
  try {
    return await withCollaborationTimeout(disconnectSharedProject(sharedProjectId, controller.signal), 'Confirming the access change');
  } catch (error) {
    throw new DisconnectProjectError('disconnect', error);
  } finally {
    controller.abort();
  }
}

export async function disconnectSavedProject(
  target: Project,
  options: { localOnly?: boolean; onStage: (stage: DisconnectProjectStage) => void }
) {
  const account = localAccountKey('disconnect-project');
  let stage: DisconnectProjectStage = 'loading';
  const advance = (next: DisconnectProjectStage) => {
    stage = next;
    if (localAccountKey('disconnect-project') !== account) {
      throw new Error('The signed-in account changed. Reopen the project in the correct account.');
    }
    options.onStage(next);
  };
  try {
    advance('loading');
    const project = await withCollaborationTimeout(getProject(target.id), 'Loading the saved project');
    if (!project || !target.sharedProjectId || project.sharedProjectId !== target.sharedProjectId) {
      throw new Error('The project or its team link changed. Close this dialog and reopen the project.');
    }
    let action: 'archived' | 'left' | 'local-only' = 'local-only';
    if (!options.localOnly) {
      advance('backup');
      // Only the backup runs inside the deadline. A late backup response must
      // never continue on to membership removal or local queue cleanup.
      await withCollaborationTimeout(
        captureSharedProjectBackup(project, 'manual', 'Local data before stopping shared project access.'),
        'Saving the shared backup', DISCONNECT_BACKUP_TIMEOUT_MS
      );
      advance('disconnect');
      action = (await disconnectProjectAccess(target.sharedProjectId)).action;
    }
    advance('local');
    await detachSavedSharedProject(project.id, target.sharedProjectId);
    const localProject = await getProject(project.id);
    if (!localProject) throw new Error('Could not load the retained local copy.');
    return { localProject, action };
  } catch (error) {
    if (error instanceof DisconnectProjectError) throw error;
    throw new DisconnectProjectError(stage, error);
  }
}
