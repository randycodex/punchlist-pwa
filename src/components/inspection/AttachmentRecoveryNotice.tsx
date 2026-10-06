'use client';

import { useEffect, useRef, useState } from 'react';
import type { UnreadableAttachment } from '@/lib/db';
import { prepareInspectionRecoveryFile } from '@/features/export/inspectionRecoveryFile';
import { useMicrosoftAuth } from '@/contexts/MicrosoftAuthContext';
import { assertLocalAccountEmail } from '@/lib/localAccount';
import { findOneDriveRecoveryPhotos, type OneDriveRecoveryPhoto } from '@/lib/oneDrive';

type PreparedFile = { url: string; filename: string; unreadableDraftAreaCount: number };

export default function AttachmentRecoveryNotice({ projectId, attachments, error, retrying, onRetry }: {
  projectId: string; attachments: UnreadableAttachment[]; error?: Error; retrying: boolean; onRetry: () => void;
}) {
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<PreparedFile>();
  const [message, setMessage] = useState('');
  const [copyFallback, setCopyFallback] = useState('');
  const microsoft = useMicrosoftAuth();
  const [checkingDrive, setCheckingDrive] = useState(false);
  const [driveMatches, setDriveMatches] = useState<OneDriveRecoveryPhoto[]>();
  const [driveMessage, setDriveMessage] = useState('');
  const active = useRef(false);
  const account = useRef(microsoft.accountEmail);
  useEffect(() => { account.current = microsoft.accountEmail; }, [microsoft.accountEmail]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => () => { if (prepared) URL.revokeObjectURL(prepared.url); }, [prepared]);

  async function prepareFile() {
    if (preparing) return;
    setPreparing(true);
    setMessage('');
    try {
      const file = await prepareInspectionRecoveryFile(projectId);
      if (!active.current) return;
      setPrepared({ filename: file.filename, unreadableDraftAreaCount: file.unreadableDraftAreaCount,
        url: URL.createObjectURL(new Blob([file.json], { type: 'application/json' })) });
    } catch (failure) {
      if (active.current) setMessage(failure instanceof Error ? failure.message : 'Could not prepare the recovery file. Your browser data was kept.');
    } finally { if (active.current) setPreparing(false); }
  }

  async function checkOneDrive() {
    if (checkingDrive) return;
    setCheckingDrive(true); setDriveMatches(undefined); setDriveMessage('');
    const email = microsoft.accountEmail;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    const assertActive = () => {
      if (!active.current || account.current !== email || controller.signal.aborted) throw new Error('OneDrive check stopped. No saved inspection was changed.');
      assertLocalAccountEmail(email ?? undefined);
    };
    try {
      if (!email || !microsoft.isSignedIn) throw new Error('OneDrive was not checked. Use the Microsoft account that owns this inspection in Profile, then return here.');
      assertActive();
      const accessToken = await microsoft.ensureAccessToken({ interactive: false });
      assertActive();
      if (!accessToken) throw new Error('OneDrive was not checked. Microsoft sign-in needs attention in Profile. Keep this browser’s saved data intact.');
      const photoIds = attachments.filter((entry) => entry.kind === 'photo' || entry.kind === 'thumbnail').map((entry) => entry.id);
      if (!photoIds.length) throw new Error('There are no unavailable photo identities to check in this unit.');
      const matches = await findOneDriveRecoveryPhotos({ accessToken, assertActive, signal: controller.signal }, photoIds);
      assertActive();
      setDriveMatches(matches);
      setDriveMessage(matches.length ? `${new Set(matches.map((match) => match.photoId)).size} photo(s) have matching filenames in OneDrive. Open the files to confirm the images are readable. Local inspection records were not replaced.` : 'No matching photo filenames were returned by OneDrive search. Recently uploaded or unindexed files may not appear; this does not prove all backup copies are absent.');
    } catch (failure) {
      if (active.current && account.current === email) setDriveMessage(controller.signal.aborted ? 'OneDrive check timed out and is incomplete. Your saved inspection was not changed.' : failure instanceof Error ? failure.message : 'OneDrive could not be checked. Your saved inspection was not changed.');
    } finally { clearTimeout(timer); if (active.current) setCheckingDrive(false); }
  }

  async function copyDetails() {
    const details = ['Punchlist attachment recovery', `Page: ${window.location.pathname}`,
      `Message: ${error?.message ?? 'Saved attachment could not be read.'}`,
      ...attachments.map((entry) => `${entry.kind}: ${entry.id}; checkpoint: ${entry.checkpointId}`)].join('\n');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(details);
      setCopyFallback('');
      setMessage('Recovery details copied.');
    } catch { setCopyFallback(details); setMessage('Select and copy the recovery details below.'); }
  }

  return <div className="max-h-[45dvh] shrink-0 overflow-y-auto border-b bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100" role="alert">
    <div className="mx-auto w-full max-w-6xl space-y-2">
      <p className="font-semibold">Saved inspection opened · Attachment recovery needed</p>
      <p>{new Set(attachments.map((entry) => entry.id)).size} saved attachment(s) could not be fully read. Results, comments, and pending changes are kept. This unit is read-only until local recovery finishes.</p>
      <p className="text-xs">Keep this browser’s saved data intact. Sync This Project confirms what reached the team.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={retrying} className="min-h-11 rounded-xl soft-control px-3 font-semibold disabled:opacity-50" onClick={onRetry}>{retrying ? 'Checking attachments…' : 'Retry attachment recovery'}</button>
        <button type="button" className="min-h-11 rounded-xl soft-control px-3 font-semibold" onClick={() => { void copyDetails(); }}>Copy recovery details</button>
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer py-3 font-semibold">Save results and comments separately</summary>
        <div className="space-y-2 pb-2">
          <p>Prepare a recovery file for all saved units in this project. Saved photo files are excluded. Keep this file for inspection recovery; it does not sync the project.</p>
          <button type="button" disabled={preparing} className="min-h-11 rounded-xl soft-control px-3 font-semibold disabled:opacity-50" onClick={() => { void prepareFile(); }}>{preparing ? 'Preparing file…' : 'Prepare inspection recovery file'}</button>
          {prepared && <div className="space-y-2">
            <p>File prepared. Tap Download and save it to Files or a location outside Safari.</p>
            <a className="inline-flex min-h-11 items-center rounded-xl soft-control px-3 font-semibold underline" href={prepared.url} download={prepared.filename} target="_blank" rel="noopener noreferrer">Download inspection recovery file</a>
            {prepared.unreadableDraftAreaCount > 0 && <p>{prepared.unreadableDraftAreaCount} area(s) had capture drafts that could not be read. Those drafts remain on this device and are excluded from this file.</p>}
          </div>}
        </div>
      </details>
      <details>
        <summary className="min-h-11 cursor-pointer py-3 font-semibold">Look for a OneDrive photo backup</summary>
        <div className="space-y-2 pb-2">
          <p>Search the signed-in Microsoft account for this unit’s unavailable photo filenames. This check does not change your saved inspection or publish changes to the team.</p>
          <button type="button" disabled={checkingDrive} className="min-h-11 rounded-xl soft-control px-3 font-semibold disabled:opacity-50" onClick={() => { void checkOneDrive(); }}>{checkingDrive ? 'Checking OneDrive…' : 'Check OneDrive for these photos'}</button>
          {driveMessage && <p role="status">{driveMessage}</p>}
          {driveMatches?.map((match) => <p key={match.id} className="break-words text-xs">{match.webUrl ? <a href={match.webUrl} target="_blank" rel="noopener noreferrer" className="underline">Open {match.name} in OneDrive</a> : match.name}<br />{match.folder}</p>)}
        </div>
      </details>
      {message && <p role="status">{message}</p>}
      {copyFallback && <textarea aria-label="Recovery details to copy" className="min-h-28 w-full rounded-lg p-2 text-gray-950" readOnly value={copyFallback} onFocus={(event) => event.currentTarget.select()} />}
    </div>
  </div>;
}
