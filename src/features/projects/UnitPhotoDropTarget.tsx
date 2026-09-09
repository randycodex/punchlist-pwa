'use client';
import type { ReactNode } from 'react';
import type { Area } from '@/types';
import PhotoDropTarget from '@/components/inspection/PhotoDropTarget';
import { createPhotoAttachment, getProjectMetadata, saveCheckpointInspectionChange } from '@/lib/db';
import { saveRecoverablePhotos } from '@/features/inspection/captureRecovery';
import { claimSharedProjectArea } from '@/lib/collaboration/areaClaims';

export default function UnitPhotoDropTarget({ projectId, area, label, disabled, onSaved, children }: {
  projectId: string; area: Area; label: string; disabled: boolean;
  onSaved: () => void; children: ReactNode;
}) {
  async function ensureEditable() {
    if (disabled) throw new Error('This unit is not available for editing.');
    const project = await getProjectMetadata(projectId);
    if (!project || project.deletedAt || !project.areas.some((entry) => entry.id === area.id && !entry.deletedAt)) throw new Error('This unit is no longer available.');
    if (project.sharedProjectId) await claimSharedProjectArea(project.sharedProjectId, area.id);
  }
  return <PhotoDropTarget label={label} destinations={[]}
    destinationRooms={disabled ? [] : area.locations.map((room) => ({ id: room.id, name: room.name, groups: room.items.map((item) => ({ id: item.id, name: item.name, destinations: item.checkpoints.map(({ id, name }) => ({ id, name })) })) }))}
    onSave={async (checkpointId, photos) => {
      await ensureEditable();
      await saveRecoverablePhotos(projectId, area.id, checkpointId, photos.map((photo) => ({ ...createPhotoAttachment(checkpointId, photo.imageData, photo.thumbnail), id: photo.id })));
      onSaved();
    }}
    onUndo={async (checkpointId, ids) => {
      await ensureEditable();
      await saveCheckpointInspectionChange(projectId, area.id, checkpointId, {}, [], { removePhotoIds: ids });
      onSaved();
    }}>{children}</PhotoDropTarget>;
}
