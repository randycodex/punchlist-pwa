# Inspection speed and reliability trial

Branch: `codex/inspection-speed-reliability`, based on `f0efe5f2bb5d01739a104ff0770cf4bd2b87d135`.

This is a local trial of the first capture and navigation improvements from the September 5 design review. It has not been deployed or validated as a field release.

## Try the flow

1. Open a unit, then a room and item. The context stays above the list.
2. Record an issue: this flags the checkpoint and opens its note/evidence editor. The result selector allows OK, Not inspected, Open, Resolved, and Verified. Correcting the result preserves notes and photos.
3. Type a note. Each change is journaled to IndexedDB without requiring blur; a 150 ms pause combines typing into one inspection-record update. The device status reports saving or failure; a failed note remains available for retry. Recent-note suggestions append text and offer Undo.
4. Take a photo. Each shutter starts its own save, with a stable attachment ID for retry. Done and camera close preserve successfully saved photos. A photo is journaled before attachment. If attachment fails after journaling, it can be restored from this area after reopening. If journal storage itself fails, the camera keeps the unsaved image open for retry.
5. Use Next item or Next room. Rooms stay in template order in the All view. Room reviewed records an explicit room review without changing untouched checkpoints to OK. To inspect shows rooms without explicit room review; Issues supports follow-up.
6. Return to the project and choose Resume inspection to restore the last room/item and scroll to it.
7. Export either an Issues report or an Inspection record. The latter uses the existing full-checklist PDF generator. The report choice explicitly describes the locally available record.

## Persistence changes

Checkpoint edits load the latest stored project inside a transaction so concurrent changes to different checkpoints do not overwrite one another. The checkpoint/area update, photo storage, personal-backup pending marker, and team-area queue record commit together. Failed transactions roll back. Identical-text retry and stable-photo-ID retry are covered by regression tests. Unrelated successful writes do not clear a failed checkpoint-save status. Room review survives project payload serialization/parsing.

## Verification

- `npm run verify`: 180 tests in 48 files, lint, TypeScript, and optimized production build passed.
- Browser at 390 × 844: issue and note editor, saved note after page reconstruction, next item, next room, explicit room review, Resume with restored item, and the report-content choices inspected.
- New regression coverage: concurrent checkpoint notes; queue failure rollback; identical retry; error retention across an unrelated save; photo deduplication; room-review persistence and payload round trip; sequential navigation.
- Test data is a local-only project named Inspection UX Trial. No production project was changed.

## Remaining work before claiming field reliability

The next slice adds a versioned offline shell, Prepare for site visit, actual cache/media checks, durable note/photo recovery, and a stricter pending-claim edit gate. Prepared project and area pages reopened in a fresh desktop tab with the preview server stopped.

Offline team reservations, voice-resource preparation, a detailed N/A workflow, report freshness/media completeness preview, and richer team-sync diagnostics remain follow-up work. Shared areas still require a confirmed online lock.

Phone camera operation, app termination during writes, quota exhaustion on real devices, airplane-mode cold start, multi-user conflicts, and live team delivery still need device/backend acceptance testing. A capture is recoverable after its journal write completes. If storage rejects that write, it is still only in memory. See [physical-device acceptance](offline-device-acceptance.md) for the exact checks still needed. No inspection-speed percentage is claimed. Measure repeated finding capture and room transitions against the current app with inspectors before deciding whether to merge.

Implementation references: [Next.js PWA guidance](https://nextjs.org/docs/app/guides/progressive-web-apps) and [MDN service worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers). No framework upgrade was required.

## Voice reliability follow-up

Voice capture now uses an AudioWorklet and writes approximately one-second PCM snapshots to the local recovery journal. Stop flushes the final partial block before transcription. A hard interruption can still lose audio that has not reached IndexedDB (normally the most recent second); storage failures remain visible and keep the in-memory recording available for retry while the editor stays open.

The voice engine is reused within a tab, rejects overlapping jobs, and resets a hung worker after three minutes. Retained recordings have playback and transcribe/restore controls in area recovery. Successful notes clear their audio only after the stored text has been checked. Recovery appends to newer notes and avoids repeating the same recovered text. Project deletion purges associated retained voice audio.

Prepare offline voice downloads/initializes the English model and exercises inference with silence. It does not guarantee speech accuracy or storage retention. The inspection offline cache includes the capture worklet; cached scripts use synthetic responses so worker bootstrap URL fragments are preserved.

Validation includes worklet stop/flush, worker reuse/timeout, audio conversion, failed-save recovery, duplicate recovery, project deletion, and cached-worker URL regression tests. Physical iPhone/Android microphone, lock-screen interruption, quota failure and recognition of noisy site terminology still require device acceptance. The English model has not been replaced or benchmarked for accuracy.

Browser verification on the local production preview successfully completed Prepare offline voice with the real model and inference runtime after activating the corrected service worker. This used silent test audio and did not record the user's microphone. The final automated suite passes 187 tests; live speech accuracy remains unmeasured.
