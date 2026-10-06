'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { ArrowLeft, Camera, ChevronDown, ChevronUp, Loader2, MessageSquareText, TriangleAlert } from 'lucide-react';
import { useCollaborationAuth } from '@/contexts/CollaborationAuthContext';
import { useSyncStatus } from '@/contexts/SyncStatusContext';
import { saveRecoverableAreaNote, saveRecoverableNote, saveRecoverablePhotos } from '@/features/inspection/captureRecovery';
import { buildProjectReviewList, type ProjectReviewEntry } from '@/features/projects/reviewList';
import { releaseSharedArea } from '@/features/collaboration/releaseSharedArea';
import { queuePendingSync } from '@/lib/pendingSync';
import {
  createPhotoAttachment,
  getProjectForArea,
  getProjectMetadata,
  saveCheckpointInspectionChange,
} from '@/lib/db';
import {
  claimSharedProjectArea,
  getActiveSharedProjectAreaClaims,
  getCollaborationErrorMessage,
  resumePendingSharedAreaSyncs,
  subscribeToSharedProjectAreaClaimChanges,
} from '@/lib/collaboration';
import { getCheckpointIssueState, type Area, type Checkpoint, type IssueState, type Project } from '@/types';

const PhotoCapture = dynamic(() => import('@/components/PhotoCapture'), { ssr: false });

function findCheckpoint(area: Area | null, checkpointId?: string): Checkpoint | null {
  if (!area || !checkpointId) return null;
  for (const location of area.locations) {
    for (const item of location.items) {
      const checkpoint = item.checkpoints.find((entry) => entry.id === checkpointId);
      if (checkpoint) return checkpoint;
    }
  }
  return null;
}

function reviewStateLabel(state: IssueState) {
  return state === 'none' ? '' : state === 'open' ? 'Issue' : state === 'resolved' ? 'Resolved' : 'Verified';
}

export default function ProjectReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const collaborationAuth = useCollaborationAuth();
  const { setStatus: setSyncStatus } = useSyncStatus();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openArea, setOpenArea] = useState<Area | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [claimedAreaIds, setClaimedAreaIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const openRequest = useRef(0);
  const releasingAreaId = useRef<string | null>(null);
  const entries = useMemo(() => project ? buildProjectReviewList(project) : [], [project]);
  const openEntry = entries.find((entry) => entry.id === openId) ?? null;
  const activeCheckpoint = findCheckpoint(openArea, openEntry?.checkpointId);
  const canEditOpenArea = Boolean(project && (!project.sharedProjectId || (openEntry && claimedAreaIds.has(openEntry.areaId))));

  useEffect(() => {
    let active = true;
    void getProjectMetadata(id).then((saved) => {
      if (active) setProject(saved && !saved.deletedAt ? saved : null);
    }).catch((cause) => {
      if (active) setError(getCollaborationErrorMessage(cause, 'Could not load this project.'));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    const sharedProjectId = project?.sharedProjectId;
    const userId = collaborationAuth.user?.id;
    if (!sharedProjectId || !userId || claimedAreaIds.size === 0) return;
    let active = true;
    const unsubscribe = subscribeToSharedProjectAreaClaimChanges(sharedProjectId, () => {
      void getActiveSharedProjectAreaClaims(sharedProjectId).then((claims) => {
        if (!active) return;
        const mine = new Set(claims.filter((claim) =>
          claim.claimedByUserId === userId
        ).map((claim) => claim.areaId));
        const retained = new Set([...claimedAreaIds].filter((areaId) => mine.has(areaId)));
        if (retained.size < claimedAreaIds.size) {
          setClaimedAreaIds(retained);
          if ([...claimedAreaIds].some((areaId) => !mine.has(areaId) && areaId !== releasingAreaId.current)) {
            setError('A team area lock was released. Saved work remains on this device; claim the area again before editing.');
          }
        }
      }).catch(() => {});
    });
    return () => { active = false; unsubscribe(); };
  }, [claimedAreaIds, collaborationAuth.user?.id, project?.sharedProjectId]);

  const refresh = useCallback(async (entry: ProjectReviewEntry) => {
    const [metadata, areaProject] = await Promise.all([
      getProjectMetadata(id),
      entry.kind === 'checkpoint' ? getProjectForArea(id, entry.areaId) : Promise.resolve(null),
    ]);
    if (!metadata || metadata.deletedAt) throw new Error('This project is no longer available.');
    setProject(metadata);
    if (openRequest.current && entry.id === openId) {
      setOpenArea(areaProject?.areas.find((area) => area.id === entry.areaId) ?? null);
    }
    queuePendingSync(id);
    setSyncStatus('pending');
    resumePendingSharedAreaSyncs();
  }, [id, openId, setSyncStatus]);

  async function saveComment(entry: ProjectReviewEntry, value = commentDraft) {
    if (value === entry.comment) return true;
    if (!project || !canEditOpenArea || busy) {
      setError('Claim this area before saving the comment. Your draft is still here.');
      return false;
    }
    setBusy(true);
    setError('');
    try {
      const committed = entry.kind === 'area-note'
        ? await saveRecoverableAreaNote(project.id, entry.areaId, value, entry.comment)
        : await saveRecoverableNote(project.id, entry.areaId, entry.checkpointId!, value, entry.comment);
      if (committed) await refresh(entry);
      return true;
    } catch (cause) {
      setError(getCollaborationErrorMessage(cause, 'Could not save this comment. Try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function selectEntry(entry: ProjectReviewEntry) {
    if (busy) return;
    if (openEntry && !(await saveComment(openEntry))) return;
    if (openId === entry.id) {
      ++openRequest.current;
      setOpenId(null);
      setOpenArea(null);
      return;
    }
    const request = ++openRequest.current;
    setOpenId(entry.id);
    setCommentDraft(entry.comment);
    setOpenArea(null);
    setError('');
    if (entry.kind === 'area-note') return;
    try {
      const saved = await getProjectForArea(id, entry.areaId);
      if (openRequest.current === request) {
        const area = saved?.areas.find((candidate) => candidate.id === entry.areaId && !candidate.deletedAt);
        setOpenArea(area ?? null);
        if (!area) setError('This area is no longer available. Return to the project and refresh.');
      }
    } catch (cause) {
      if (openRequest.current === request) setError(getCollaborationErrorMessage(cause, 'Could not load this checkpoint.'));
    }
  }

  async function startEditing(entry: ProjectReviewEntry) {
    if (!project) return;
    if (!project.sharedProjectId) return;
    if (!collaborationAuth.isSignedIn) {
      setError('Sign in to your team account to edit this project.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await claimSharedProjectArea(project.sharedProjectId, entry.areaId);
      setClaimedAreaIds((current) => new Set(current).add(entry.areaId));
      resumePendingSharedAreaSyncs();
    } catch (cause) {
      setError(getCollaborationErrorMessage(cause, 'This area is locked. Try again when it is released.'));
    } finally {
      setBusy(false);
    }
  }

  async function releaseArea(entry: ProjectReviewEntry) {
    if (!project?.sharedProjectId || busy) return;
    if (!(await saveComment(entry))) return;
    setBusy(true);
    setError('');
    releasingAreaId.current = entry.areaId;
    try {
      await releaseSharedArea({
        localProjectId: project.id,
        sharedProjectId: project.sharedProjectId,
        areaId: entry.areaId,
      });
      setClaimedAreaIds((current) => {
        const next = new Set(current);
        next.delete(entry.areaId);
        return next;
      });
    } catch (cause) {
      setError(getCollaborationErrorMessage(cause, 'Could not release this area. Sync pending work, then try again.'));
    } finally {
      releasingAreaId.current = null;
      setBusy(false);
    }
  }

  async function changeStatus(entry: ProjectReviewEntry, value: string) {
    if (!project || !entry.checkpointId || !canEditOpenArea || busy) return;
    const change = value === 'pending'
      ? { status: 'pending' as const, issueState: 'none' as const, fixStatus: 'pending' as const }
      : value === 'ok'
        ? { status: 'ok' as const, issueState: 'none' as const, fixStatus: 'pending' as const }
        : { status: 'needsReview' as const, issueState: value as Exclude<IssueState, 'none'>,
          fixStatus: value === 'verified' ? 'verified' as const : value === 'resolved' ? 'fixed' as const : 'pending' as const };
    setBusy(true);
    setError('');
    try {
      await saveCheckpointInspectionChange(project.id, entry.areaId, entry.checkpointId, change);
      await refresh(entry);
    } catch (cause) {
      setError(getCollaborationErrorMessage(cause, 'Could not save this status.'));
    } finally {
      setBusy(false);
    }
  }

  async function addPhotos(entry: ProjectReviewEntry, photos: Array<{ imageData: string; thumbnail?: string; id?: string }>) {
    if (!project || !entry.checkpointId || !canEditOpenArea) throw new Error('Claim this area before adding photos.');
    const attachments = photos.map((photo) => ({
      ...createPhotoAttachment(entry.checkpointId!, photo.imageData, photo.thumbnail),
      ...(photo.id ? { id: photo.id } : {}),
    }));
    setBusy(true);
    setError('');
    try {
      await saveRecoverablePhotos(project.id, entry.areaId, entry.checkpointId, attachments);
      await refresh(entry);
    } catch (cause) {
      setError(getCollaborationErrorMessage(cause, 'Could not save these photos.'));
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoto(entry: ProjectReviewEntry, photoId: string) {
    if (!project || !entry.checkpointId || !canEditOpenArea || busy) return;
    setBusy(true);
    setError('');
    try {
      await saveCheckpointInspectionChange(project.id, entry.areaId, entry.checkpointId, {}, [], { removePhotoIds: [photoId] });
      await refresh(entry);
    } catch (cause) {
      setError(getCollaborationErrorMessage(cause, 'Could not delete this photo.'));
    } finally {
      setBusy(false);
    }
  }

  async function leaveReview() {
    if (busy) return;
    if (openEntry && !(await saveComment(openEntry))) return;
    router.push(`/project/${id}`);
  }

  return (
    <main className="app-page min-h-0 overflow-y-auto px-4 pb-10 pt-5 sm:px-5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex items-start gap-3">
          <button type="button" onClick={() => void leaveReview()} aria-label="Back to project" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-black/[0.08] dark:bg-white/[0.08]">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 pt-0.5">
            <p className="truncate text-sm text-gray-500 dark:text-gray-400">{project?.projectName ?? 'Project'}</p>
            <h1 className="text-2xl font-semibold">Review activity</h1>
          </div>
        </div>

        {loading ? <p className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p> : !project ? (
          <p className="text-sm text-gray-500">Project not found on this device.</p>
        ) : (
          <>
            <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">{entries.length} {entries.length === 1 ? 'entry' : 'entries'} with a comment, photo, attachment, or issue</p>
            {entries.length === 0 && <p className="rounded-2xl bg-[var(--surface)] p-5 text-sm">Nothing to review yet.</p>}
            <div className="space-y-3">
              {entries.map((entry) => {
                const isOpen = openId === entry.id;
                const editing = !project.sharedProjectId || claimedAreaIds.has(entry.areaId);
                const checkpoint = isOpen ? activeCheckpoint : null;
                return (
                  <section key={entry.id} className="overflow-hidden rounded-[1.4rem] bg-[var(--surface)]">
                    <button type="button" onClick={() => void selectEntry(entry)} aria-expanded={isOpen} className="w-full px-4 py-4 text-left sm:px-5">
                      <span className="block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{entry.path.join(' › ')}</span>
                      <span className="mt-1 flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-base font-semibold">{entry.title}</span>
                        {isOpen ? <ChevronUp className="h-4 w-4 shrink-0 text-gray-500" /> : <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" />}
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                        {entry.issueState !== 'none' && <span className="flex items-center gap-1 text-[var(--accent)]"><TriangleAlert className="h-3.5 w-3.5" /> {reviewStateLabel(entry.issueState)}</span>}
                        {entry.photoCount > 0 && <span className="flex items-center gap-1"><Camera className="h-3.5 w-3.5" /> {entry.photoCount} {entry.photoCount === 1 ? 'photo' : 'photos'}</span>}
                        {entry.comment.trim() && <span className="flex items-center gap-1"><MessageSquareText className="h-3.5 w-3.5" /> Comment</span>}
                        {entry.fileCount > 0 && <span>{entry.fileCount} {entry.fileCount === 1 ? 'attachment' : 'attachments'}</span>}
                      </span>
                      {!isOpen && entry.comment.trim() && <span className="mt-2 block truncate text-sm text-gray-600 dark:text-gray-300">{entry.comment}</span>}
                    </button>
                    {isOpen && (
                      <div className="border-t border-black/5 px-4 pb-5 pt-4 dark:border-white/10 sm:px-5">
                        {error && <p role="alert" className="mb-4 rounded-xl bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">{error}</p>}
                        {project.sharedProjectId && (
                          <div className="mb-4 flex items-center gap-3">
                            {editing ? (
                              <><span className="text-xs text-emerald-700 dark:text-emerald-400">Editing this area</span><button type="button" disabled={busy} onClick={() => void releaseArea(entry)} className="text-xs underline disabled:opacity-50">Release lock</button></>
                            ) : (
                              <button type="button" disabled={busy} onClick={() => void startEditing(entry)} className="rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Edit this area</button>
                            )}
                          </div>
                        )}
                        {entry.kind === 'checkpoint' && !checkpoint && <p className="text-sm text-gray-500">Loading photos…</p>}
                        {entry.kind === 'checkpoint' && checkpoint && (
                          <div className="mb-4">
                            <label htmlFor={`review-status-${entry.id}`} className="mb-1 block text-xs font-semibold text-gray-500 dark:text-gray-400">Status</label>
                            <select id={`review-status-${entry.id}`} disabled={!editing || busy} value={getCheckpointIssueState(checkpoint) === 'none' ? checkpoint.status : getCheckpointIssueState(checkpoint)} onChange={(event) => void changeStatus(entry, event.target.value)} className="min-h-10 rounded-xl bg-black/[0.06] px-3 text-sm disabled:opacity-60 dark:bg-white/[0.08]">
                              <option value="pending">To inspect</option><option value="ok">Reviewed</option><option value="open">Issue</option><option value="resolved">Resolved</option><option value="verified">Verified</option>
                            </select>
                          </div>
                        )}
                        {checkpoint && (
                          <div className="mb-5">
                            <p className="mb-2 text-xs font-semibold text-gray-500 dark:text-gray-400">Photos</p>
                            <PhotoCapture
                              contextLabel={entry.path.join(' › ')}
                              photos={checkpoint.photos}
                              files={[]}
                              readOnly={!editing || busy}
                              onAddPhoto={(imageData, thumbnail) => addPhotos(entry, [{ imageData, thumbnail }])}
                              onAddPhotos={(photos) => addPhotos(entry, photos)}
                              onDeletePhoto={(photoId) => { void deletePhoto(entry, photoId); }}
                              onDeleteFile={() => {}}
                            />
                            {(checkpoint.files?.length ?? 0) > 0 && (
                              <div className="mt-4 space-y-1 text-sm">
                                <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Attachments</p>
                                {checkpoint.files.map((file) => <a key={file.id} href={file.data} download={file.name} className="block truncate underline">{file.name}</a>)}
                              </div>
                            )}
                          </div>
                        )}
                        <label htmlFor={`review-comment-${entry.id}`} className="mb-1 block text-xs font-semibold text-gray-500 dark:text-gray-400">Comment</label>
                        <textarea id={`review-comment-${entry.id}`} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} readOnly={!editing} rows={3} placeholder={editing ? 'Add a comment' : undefined} className="w-full resize-y rounded-xl bg-black/[0.06] p-3 text-sm outline-none focus:ring-2 focus:ring-[var(--accent)] read-only:opacity-70 dark:bg-white/[0.08]" />
                        {editing && commentDraft !== entry.comment && <button type="button" disabled={busy} onClick={() => void saveComment(entry)} className="mt-2 rounded-full bg-black/[0.08] px-4 py-2 text-sm font-semibold disabled:opacity-50 dark:bg-white/[0.08]">Save comment</button>}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
        {error && !openEntry && <p role="alert" className="mt-4 rounded-xl bg-amber-100 p-3 text-sm text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">{error}</p>}
      </div>
    </main>
  );
}
