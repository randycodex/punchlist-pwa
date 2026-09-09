'use client';

import { useRef, useState, type ReactNode, type DragEvent, type RefObject } from 'react';
import { fileToPhotoPayload } from '@/lib/photoPayload';

export type DroppedPhoto = { id: string; imageData: string; thumbnail?: string };
type Destination = { id: string; name: string };

export default function PhotoDropTarget({ children, label, destinations, onSave, onUndo, onCreate, pickerRef }: {
  pickerRef?: RefObject<HTMLInputElement | null>;
  onCreate?: (name: string, allUnits: boolean) => Promise<Destination>;
  children: ReactNode;
  label: string;
  destinations: Destination[];
  onSave: (checkpointId: string, photos: DroppedPhoto[]) => Promise<void>;
  onUndo: (checkpointId: string, ids: string[]) => Promise<void>;
}) {
  const [allUnits, setAllUnits] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [over, setOver] = useState(false);
  const [pending, setPending] = useState<File[]>([]);
  const [status, setStatus] = useState('');
  const [batch, setBatch] = useState<{ checkpointId: string; ids: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const depth = useRef(0);

  async function save(files: File[], destination: Destination) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPending([]);
    setBatch(null);
    const ids: string[] = [];
    let skipped = 0;
    try {
      for (const [index, file] of files.entries()) {
        setStatus(`Adding ${index + 1} of ${files.length}…`);
        if ((!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i.test(file.name)) || file.size > 25 * 1024 * 1024) {
          skipped++;
          continue;
        }
        const payload = await fileToPhotoPayload(file);
        if (!payload) { skipped++; continue; }
        const photo = { ...payload, id: crypto.randomUUID() };
        await onSave(destination.id, [photo]);
        ids.push(photo.id);
      }
      setStatus(`${ids.length} photos saved to ${label} → ${destination.name}.${skipped ? ` ${skipped} files skipped: use readable images under 25 MB.` : ''}`);
    } catch {
      setStatus(`${ids.length} photos saved. The remaining photos could not be added. Try again with the remaining files.`);
    } finally {
      if (ids.length) setBatch({ checkpointId: destination.id, ids });
      busyRef.current = false;
      setBusy(false);
    }
  }

  function receive(files: File[]) {
    if (busyRef.current || !files.length) return;
    if (destinations.length === 1 && !onCreate) void save(files, destinations[0]);
    else { setPending(files); setCreating(false); setNewName(''); setAllUnits(false); }
  }

  function drag(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes('Files')) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  return <div
    className={`rounded-[1.3rem] ${over ? 'ring-2 ring-[var(--accent)] bg-[var(--surface-strong)]' : ''}`}
    data-photo-drop-target={label}
    onDragEnter={(event) => { if (drag(event)) { depth.current++; setOver(true); } }}
    onDragOver={(event) => { if (drag(event)) event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; }}
    onDragLeave={(event) => { if (drag(event)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); } }}
    onDrop={(event) => {
      if (!drag(event)) return;
      depth.current = 0; setOver(false);
      receive(Array.from(event.dataTransfer.files));
    }}
  >
    {over && <p className="px-4 py-2 text-sm font-medium accent-text">{busy ? 'Please wait for these photos to finish saving' : `Drop photos onto ${label}`}</p>}
    {children}
    <input ref={pickerRef} type="file" disabled={busy} multiple accept="image/*,.heic,.heif" className="hidden" aria-label={`Choose photos for ${label}`} onChange={(event) => { receive(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    {(pending.length > 0 || status || batch) && <div data-inspection-inline-action="true" className="px-3 pb-2" onClick={(event) => event.stopPropagation()}>
      {pending.length > 0 && <div className="space-y-2 py-2">
        <p className="text-sm">Add {pending.length} photos to {label}:</p>
        {destinations.map((destination) => <button key={destination.id} type="button" disabled={busy} className="m-1 min-h-11 rounded-xl px-3 soft-control text-sm" onClick={() => void save(pending, destination)}>{destination.name}</button>)}
        {onCreate && <button type="button" disabled={busy} className="min-h-11 px-3 text-sm accent-text" onClick={() => setCreating(true)}>New checkpoint…</button>}
        {creating && <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
          event.preventDefault();
          if (!onCreate || !newName.trim() || busyRef.current) return;
          busyRef.current = true; setBusy(true);
          try {
            const destination = await onCreate(newName.trim(), allUnits);
            busyRef.current = false;
            await save(pending, destination);
            setCreating(false); setNewName('');
          } catch (error) {
            setStatus(error instanceof Error ? error.message : 'Could not create checkpoint.');
          } finally { busyRef.current = false; setBusy(false); }
        }}>
          <input autoFocus aria-label="New checkpoint name" value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} className="field-shell min-h-11 px-3 text-sm" placeholder="Checkpoint name" />
          <label className="flex w-full items-center gap-2 text-sm"><input type="checkbox" checked={allUnits} disabled={busy} onChange={(event) => setAllUnits(event.target.checked)} />Add to matching room and item in all existing and future units</label>
          <button type="submit" disabled={busy || !newName.trim()} className="min-h-11 px-3 text-sm accent-text">Create and add photos</button>
        </form>}
        <button type="button" disabled={busy} className="min-h-11 px-3 text-sm" onClick={() => setPending([])}>Cancel</button>
      </div>}
      {status && <p role="status" className="py-1 text-xs text-gray-500 dark:text-gray-400">{status}</p>}
      {batch && <button type="button" disabled={busy} className="min-h-9 px-2 text-xs font-medium accent-text" onClick={async () => {
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true);
        try { await onUndo(batch.checkpointId, batch.ids); setBatch(null); setStatus('Added photos removed.'); }
        catch { setStatus('Could not undo this batch. Try again.'); }
        finally { busyRef.current = false; setBusy(false); }
      }}>Undo batch</button>}
    </div>}
  </div>;
}
