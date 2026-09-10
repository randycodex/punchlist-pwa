'use client';

import { useRef, useState, type ReactNode, type DragEvent, type RefObject } from 'react';
import { fileToPhotoPayload } from '@/lib/photoPayload';

export type DroppedPhoto = { id: string; imageData: string; thumbnail?: string };
type DestinationGroup = { id: string; name: string; destinations: Destination[]; onCreate?: (name: string, allUnits: boolean) => Promise<Destination> };
type Destination = { id: string; name: string };

export default function PhotoDropTarget({ children, label, destinations, onSave, onUndo, onCreate, pickerRef, destinationGroups, destinationRooms }: {
  destinationRooms?: Array<{ id: string; name: string; groups: DestinationGroup[] }>;
  destinationGroups?: DestinationGroup[];
  pickerRef?: RefObject<HTMLInputElement | null>;
  onCreate?: (name: string, allUnits: boolean) => Promise<Destination>;
  children: ReactNode;
  label: string;
  destinations: Destination[];
  onSave: (checkpointId: string, photos: DroppedPhoto[]) => Promise<void>;
  onUndo: (checkpointId: string, ids: string[]) => Promise<void>;
}) {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const selectedRoom = destinationRooms?.find((room) => room.id === selectedRoomId);
  const groups = destinationRooms ? selectedRoom?.groups : destinationGroups;
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const selectedGroup = groups?.find((group) => group.id === selectedGroupId);
  const availableDestinations = selectedGroup?.destinations ?? destinations;
  const createDestination = (destinationGroups || destinationRooms) ? selectedGroup?.onCreate : onCreate;
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
    const skipped: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setStatus(`Adding ${index + 1} of ${files.length}…`);
        if (file.size > 25 * 1024 * 1024) {
          skipped.push(`${file.name}: exceeds 25 MB`);
          continue;
        }
        if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i.test(file.name)) {
          skipped.push(`${file.name}: unsupported file type`);
          continue;
        }
        let payload;
        try { payload = await fileToPhotoPayload(file); }
        catch { payload = null; }
        if (!payload) {
          skipped.push(`${file.name}: could not read or decode this image; try exporting a new JPG or PNG`);
          continue;
        }
        const photo = { ...payload, id: crypto.randomUUID() };
        await onSave(destination.id, [photo]);
        ids.push(photo.id);
      }
      setStatus(`${ids.length} photos saved to ${label} → ${destination.name}.${skipped.length ? ` ${skipped.length} files skipped. ${skipped.join('; ')}.` : ''}`);
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
    if (!destinationRooms && !destinationGroups && destinations.length === 1 && !onCreate) void save(files, destinations[0]);
    else { setSelectedRoomId(null); setSelectedGroupId(null); setPending(files); setCreating(false); setNewName(''); setAllUnits(false); }
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
    {children}
    <input ref={pickerRef} type="file" disabled={busy} multiple accept="image/*,.heic,.heif" className="hidden" aria-label={`Choose photos for ${label}`} onChange={(event) => { receive(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    {(pending.length > 0 || status || batch) && <div data-inspection-inline-action="true" className="px-3 pb-2" onClick={(event) => event.stopPropagation()}>
      {pending.length > 0 && <div className="space-y-2 py-2">
        <p className="text-sm">Add {pending.length} photos to {label}:</p>
        {destinationRooms && !selectedRoom && <><p className="text-sm font-medium">Choose a sub-area:</p>{!destinationRooms.length && <p>No sub-areas are available for photo uploads.</p>}{destinationRooms.map((room) => <button key={room.id} type="button" className="m-1 min-h-11 rounded-xl px-3 soft-control text-sm" onClick={() => setSelectedRoomId(room.id)}>{room.name}</button>)}</>}
        {selectedRoom && <div className="text-sm"><button type="button" className="min-h-11 px-2 accent-text" onClick={() => { setSelectedRoomId(null); setSelectedGroupId(null); setCreating(false); }}>← Sub-areas</button>{selectedRoom.name}</div>}
        {groups && !selectedGroup && <>
          <p className="text-sm font-medium">Choose an item:</p>
          {groups.map((group) => <button key={group.id} type="button" className="m-1 min-h-11 rounded-xl px-3 soft-control text-sm" onClick={() => setSelectedGroupId(group.id)}>{group.name}</button>)}
          {!groups.length && <p className="text-sm">Add an item to this sub-area first.</p>}
        </>}
        {selectedGroup && <div className="text-sm"><button type="button" className="min-h-11 px-2 accent-text" onClick={() => { setSelectedGroupId(null); setCreating(false); setNewName(''); setAllUnits(false); }}>← Items</button><span>{selectedGroup.name} — choose a checkpoint:</span></div>}
        {availableDestinations.map((destination) => <button key={destination.id} type="button" disabled={busy} className="m-1 min-h-11 rounded-xl px-3 soft-control text-sm" onClick={() => void save(pending, destination)}>{destination.name}</button>)}
        {createDestination && <button type="button" disabled={busy} className="min-h-11 px-3 text-sm accent-text" onClick={() => setCreating(true)}>New checkpoint…</button>}
        {creating && <form className="flex flex-wrap gap-2" onSubmit={async (event) => {
          event.preventDefault();
          if (!createDestination || !newName.trim() || busyRef.current) return;
          busyRef.current = true; setBusy(true);
          try {
            const destination = await createDestination(newName.trim(), allUnits);
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
