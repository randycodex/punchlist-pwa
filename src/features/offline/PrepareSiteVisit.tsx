'use client';

import { useState } from 'react';
import type { Project } from '@/types';
import { getProject } from '@/lib/db';
import { checkPreparedPages, inspectOfflineProject, offlineBuild } from './sitePreparation';

export default function PrepareSiteVisit({ project }: { project: Project }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Prepare while online before going to the site.');
  async function prepare(download = true) {
    setBusy(true);
    setMessage(download ? 'Checking saved data and downloading inspection pages…' : 'Checking the saved copy…');
    try {
      const stored = await getProject(project.id);
      if (!stored || stored.deletedAt) throw new Error('Save this project on this device first.');
      const summary = inspectOfflineProject(stored);
      const result = await checkPreparedPages(summary.paths, download);
      if (!result.ready) throw new Error('Some app files are missing. Reconnect and prepare again.');
      const persistent = navigator.storage?.persist ? await navigator.storage.persist().catch(() => false) : false;
      setMessage(`Area pages stored: ${summary.areaCount}. ${summary.missingMedia ? `${summary.missingMedia} media files are missing; retrieve them from backup before leaving.` : 'Current photos, files, and drawings are on this device.'} ${summary.shared ? 'Team areas still need an online lock to edit.' : 'This personal project can be inspected offline.'} ${persistent ? '' : 'Your browser may remove storage when space is low.'}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Preparation failed. Stay online and retry.'); }
    finally { setBusy(false); }
  }
  return <details className="mx-auto mb-4 w-full max-w-6xl rounded-2xl soft-control px-4 py-3 text-sm">
    <summary className="cursor-pointer font-semibold">Prepare for site visit</summary>
    <p className="mt-3 text-xs text-gray-600 dark:text-gray-300" role="status">{message}</p>
    <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Voice transcription requires its separate first-use download. Preparation does not fetch newer team changes; Get Team Updates first.</p>
    <button type="button" disabled={busy || offlineBuild === 'development'} onClick={() => void prepare()} className="mt-3 min-h-11 rounded-xl accent-bg px-4 font-semibold text-white disabled:opacity-50">{busy ? 'Preparing…' : 'Prepare this project'}</button>
    <button type="button" disabled={busy || offlineBuild === 'development'} onClick={() => void prepare(false)} className="ml-2 mt-3 min-h-11 rounded-xl px-3 font-semibold disabled:opacity-50">Check saved copy</button>
    {offlineBuild === 'development'  && <p className="mt-2 text-xs text-gray-500">Use the production preview to test offline preparation.</p>}
  </details>;
}
