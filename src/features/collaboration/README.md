# collaboration

Goal: allow UAI users to contribute to one shared master project, keep field use reliable when the network is weak, and export one combined PDF at the end of the day.

## Current boundary

The app is local-first today. Projects are stored in IndexedDB, and OneDrive sync moves whole-project snapshots through each signed-in user's own OneDrive account. That is useful for backup and single-user device sync, but it is not safe as the source of truth for concurrent team editing.

The first release should not be a full live-editing system. It should be shared project consolidation: multiple users work in different project areas, sync back to one master project, and export one PDF from that master record.

## Collaboration model

- A shared project has one server-owned `projectId`.
- A UAI user creates the project and becomes the initial owner.
- Ownership can be transferred to another allowed project member.
- Users join through invitations or a project join code that only works after Microsoft sign-in with an allowed collaboration account.
- Every accepted member can inspect and edit; do not expose roles in the first UI.
- IndexedDB remains the offline cache for projects and queued local edits.
- The backend is authoritative for shared projects.
- OneDrive can remain export, backup, or legacy personal sync storage, but it should not arbitrate live collaboration.

## Area claiming

The core guardrail is area-level claiming, not full real-time document locking.

- When a user starts working on an existing area, the app creates an active area claim.
- Other users can see that the area is in use and cannot edit that same area unless the current claim holder releases it or explicitly hands it off.
- A stale claim can expire after a timeout so a project does not get permanently stuck if a device dies.
- Another user can still create a completely new area with the same label/name when the field condition is genuinely separate.
- The UI must distinguish "open existing claimed area" from "create new area with this same label" so users do not accidentally fork work.

Example: if Randy is working on `Apartment 3B`, another member should not edit that same `Area.id`. They may create a new `Apartment 3B` area only if it is intentionally a separate inspection area, and the app should make that explicit before saving.

## Entity granularity

Use the existing hierarchy as the sync boundary:

- `Project`
- `Area`
- `Location`
- `Item`
- `Checkpoint`
- `PhotoAttachment`
- `FileAttachment`

Most field collaboration should happen at area, checkpoint, comment, status, and attachment level. Avoid replacing entire project JSON when one checkpoint changes.

## Mutation flow

1. User edits locally.
2. App saves the local IndexedDB cache immediately.
3. App queues a collaboration mutation with project, entity, operation, timestamp, and author.
4. If online, app sends queued mutations to the backend.
5. Backend validates UAI membership, active area claim, and merge rules.
6. Other active clients receive the accepted mutation through a realtime channel.
7. Clients reconcile their local cache from accepted mutations or a fresh project snapshot.

## Initial merge rules

- Different areas merge automatically.
- Existing claimed areas can only be edited by the current claim holder.
- New areas can be created even when they share a display label with another area, because identity is based on `area.id`, not name alone.
- Checkpoint status uses latest accepted change, with audit history.
- Checkpoint comments can use latest accepted change for phase one, then add conflict UI if needed.
- Attachments are append-only unless explicitly deleted.
- Deletes should use tombstones so offline devices do not revive deleted records.
- Project metadata edits use latest accepted change with audit history.

## Membership

Start simple: no visible roles for the first release.

- `ownerUserId` is stored on the shared project and can be transferred.
- Every active member can edit inspection data and export the combined PDF.
- Membership records still track who joined, who invited them, and whether access was removed.
- More roles can be added later if needed, but do not complicate the first release.

The current invite UI creates one expiring server-side join code and presents it
as a shareable link, QR code, and copyable fallback code. A link opens the home
join flow with the code prefilled. Direct email delivery is not implemented yet.
Ownership transfer belongs in member management and is available only to the
current owner for an existing active member.

Because each browser keeps its own IndexedDB cache, account membership and local
availability are separate. `Download to this device` hydrates a project that the
signed-in member can access but that is not yet stored on the current device.

## Backend responsibilities

- Authenticate users with the existing Microsoft sign-in identity.
- Enforce UAI production access, plus temporary exact-email allowlist entries for testing.
- Create and validate project join codes.
- Store project membership.
- Store project ownership and ownership transfer history.
- Store active area claims and claim handoffs.
- Store shared project entities and attachments metadata.
- Accept idempotent mutation records.
- Reject edits from users without project access.
- Reject edits to an existing area when another active member holds the claim.
- Broadcast accepted mutations to subscribed clients.
- Keep an audit trail for important field changes.

## Storage responsibilities

- Project entities live in database tables or collections.
- Attachment files live in shared object storage.
- IndexedDB keeps local hydrated project data and pending mutation queues.
- OneDrive export paths should remain separate from shared collaboration storage.

## Implementation phases

### Phase 1: shared-project foundation

- Add backend choice and environment configuration.
- Add shared project and membership schema.
- Map Microsoft account identity to backend user records.
- Add allowed-email invitation and join-code flow.
- Add transferable project ownership.
- Keep existing local project screens while introducing shared project metadata.

### Phase 2: area claims and consolidated sync

- Add active area claim records.
- Block editing of an existing area when another member holds the active claim.
- Add release, timeout, and handoff paths.
- Allow explicit creation of a new area even when another area has the same label.
- Make PDF export use the master merged project.

### Phase 3: mutation queue

- Area edits now save locally first, coalesce in the durable IndexedDB
  `sharedAreaSyncQueue`, and publish compact current-area rows in the background.
- Area creation, trash, and restore actions from project lists use the same
  compact queue instead of loading and checking an entire project snapshot.
- Area RPC retries use client-generated idempotency keys and optimistic versions;
  stale updates pause for review instead of overwriting team data.
- Extend the same queue contract to project, location, item, and checkpoint audit
  records only when finer history is needed; area payloads are the current merge
  boundary.
- Conflict-safe tombstones remain required before hard-deleting shared entities.

### Phase 4: project session updates

- Subscribe open project pages to backend project channels.
- Apply accepted remote mutations into IndexedDB and React state.
- Show lightweight presence: who is currently in the project and which areas are claimed.
- The persistent top bar surfaces durable shared-area work that is pending or
  blocked for review; per-project history remains a later refinement.

### Phase 5: conflict and audit UI

- Add edit history for checkpoint status, comments, and project metadata.
- Add conflict prompts where latest-wins is not acceptable.
- Add member removal.
- Add admin recovery tools for stuck pending mutations.

## Decisions still needed

- Backend platform: Supabase/Firebase/Convex/custom Next.js API plus Postgres.
- Shared media storage is Supabase Storage via the private `punchlist-attachments` bucket; future work should focus on lifecycle cleanup and smaller area-level mutations.
- UAI email domain or tenant ID that should be accepted for production.
- Temporary exact-email test allowlist entries, if non-UAI testers need access before the production identity model is widened.
- Join-code lifetime and whether join requests require approval.
- Area claim timeout duration.
- Whether first release can use latest-wins comments or needs append-only comments immediately.

## Environment

Local and deployed environments need these public settings:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_publishable_key
NEXT_PUBLIC_UAI_EMAIL_DOMAIN=uai-ny.com
NEXT_PUBLIC_COLLABORATION_ALLOWED_EMAILS=tester@gmail.com
NEXT_PUBLIC_COLLABORATION_JOIN_CODE_TTL_MS=604800000
```

The join-code and exact-email allowlist values are optional. Join codes default to 7 days. Area claims remain active until the claimant explicitly releases them from the area's actions menu. Keep `NEXT_PUBLIC_COLLABORATION_ALLOWED_EMAILS` to temporary test accounts only; it does not replace a production arbitrary-email identity model.

## Shared snapshot payloads

Version 1 stores legacy inline project JSON. Version 2 keeps the project
hierarchy in JSON and stores binary media in the private Supabase attachment
bucket. New clients read both versions; attachment-bearing publishes use version
2 so database snapshots and history rows no longer duplicate base64 content.

The full snapshot is now the initial baseline and recovery point. Subsequent
field edits publish to `shared_project_area_snapshots`, one current compact row
per `Area.id`. Pulls fetch only rows newer than the baseline, while full and
area publishes share a short database lock and optimistic checks so neither can
erase a concurrent update.
