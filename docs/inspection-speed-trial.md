# Inspection speed and reliability trial

Branch: `codex/inspection-speed-reliability`, based on `f0efe5f2bb5d01739a104ff0770cf4bd2b87d135`.

This is a local trial of the first capture and navigation improvements from the September 5 design review. It has not been deployed or validated as a field release.

## Try the flow

1. Open a unit, then a room and item. The context stays above the list.
2. Record an issue: this flags the checkpoint and opens its note/evidence editor. The result selector allows OK, Not inspected, Open, Resolved, and Verified. Correcting the result preserves notes and photos.
3. Type a note. Each change starts an IndexedDB save without requiring blur. The device status reports saving or failure; a failed note remains available for retry. Recent-note suggestions append text and offer Undo.
4. Take a photo. Each shutter starts its own save, with a stable attachment ID for retry. Done and camera close preserve successfully saved photos. A failed photo blocks closing the camera until retried; it is not durable until the save succeeds.
5. Use Next item or Next room. Rooms stay in template order in the All view. Room reviewed records an explicit room review without changing untouched checkpoints to OK. To inspect shows rooms without explicit room review; Issues supports follow-up.
6. Return to the project and choose Resume inspection to restore the last room/item and scroll to it.
7. Export either an Issues report or an Inspection record. The latter uses the existing full-checklist PDF generator. The report choice explicitly describes the locally available record.

## Persistence changes

Checkpoint edits load the latest stored project inside a transaction so concurrent changes to different checkpoints do not overwrite one another. The checkpoint/area update, photo storage, personal-backup pending marker, and team-area queue record commit together. Failed transactions roll back. Identical-text retry and stable-photo-ID retry are covered by regression tests. Unrelated successful writes do not clear a failed checkpoint-save status. Room review survives project payload serialization/parsing.

## Verification

- `npm run verify`: 168 tests in 46 files, lint, TypeScript, and optimized production build passed.
- Browser at 390 × 844: issue and note editor, saved note after page reconstruction, next item, next room, explicit room review, Resume with restored item, and the report-content choices inspected.
- New regression coverage: concurrent checkpoint notes; queue failure rollback; identical retry; error retention across an unrelated save; photo deduplication; room-review persistence and payload round trip; sequential navigation.
- Test data is a local-only project named Inspection UX Trial. No production project was changed.

## Remaining work before claiming field reliability

This trial does not introduce offline application-shell caching, offline team reservations, Prepare for site visit, a detailed N/A workflow, a report freshness/media completeness preview, or new team-sync diagnostics. These remain follow-up work; existing server claim and conflict protections remain in force.

Phone camera operation, app termination during writes, quota exhaustion on real devices, airplane-mode cold start, multi-user conflicts, and live team delivery still need device/backend acceptance testing. A pending photo that cannot be saved is held in memory, and must not be described as recoverable after termination. No inspection-speed percentage is claimed. Measure repeated finding capture and room transitions against the current app with inspectors before deciding whether to merge.
