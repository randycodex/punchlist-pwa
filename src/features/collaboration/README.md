# collaboration

Goal: allow multiple signed-in users to work in one shared project at the same time while keeping field use reliable when the network is weak.

## Current boundary

The app is local-first today. Projects are stored in IndexedDB, and OneDrive sync moves whole-project snapshots through each signed-in user's own OneDrive account. That is useful for backup and single-user device sync, but it is not safe as the source of truth for concurrent team editing.

True collaboration needs a backend-owned project record, project membership, entity-level mutations, shared media storage, and live updates.

## Collaboration model

- A shared project has one server-owned `projectId`.
- Users join a project through membership records, not by sharing local browser storage or OneDrive files.
- IndexedDB remains the offline cache for projects and queued local edits.
- The backend is authoritative for shared projects.
- OneDrive can remain export, backup, or legacy personal sync storage, but it should not arbitrate live collaboration.

## Entity granularity

Use the existing hierarchy as the sync boundary:

- `Project`
- `Area`
- `Location`
- `Item`
- `Checkpoint`
- `PhotoAttachment`
- `FileAttachment`

Most field collaboration should happen at checkpoint, comment, status, and attachment level. Avoid replacing entire project JSON when one checkpoint changes.

## Mutation flow

1. User edits locally.
2. App saves the local IndexedDB cache immediately.
3. App queues a collaboration mutation with project, entity, operation, timestamp, and author.
4. If online, app sends queued mutations to the backend.
5. Backend validates membership and applies merge rules.
6. Other active clients receive the accepted mutation through a realtime channel.
7. Clients reconcile their local cache from accepted mutations or a fresh project snapshot.

## Initial merge rules

- Different entities merge automatically.
- Checkpoint status uses latest accepted change, with audit history.
- Checkpoint comments can use latest accepted change for phase one, then add conflict UI if needed.
- Attachments are append-only unless explicitly deleted.
- Deletes should use tombstones so offline devices do not revive deleted records.
- Project metadata edits use latest accepted change with audit history.

## Roles

Start simple:

- `owner`: manage project, members, delete/archive, edit all inspection data.
- `editor`: edit inspection data and upload attachments.
- `viewer`: read-only access and export.

Additional signoff-specific roles can be added after the shared editing path works.

## Backend responsibilities

- Authenticate users with the existing Microsoft sign-in identity.
- Store project membership.
- Store shared project entities and attachments metadata.
- Accept idempotent mutation records.
- Reject edits from users without project access.
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
- Add project invitation or member-management API.
- Keep existing local project screens while introducing shared project metadata.

### Phase 2: mutation queue

- Add local mutation records for project, area, location, item, checkpoint, and attachment edits.
- Replace direct collaboration-bound saves with "save local + enqueue mutation".
- Add idempotency keys so retries do not duplicate edits.
- Add conflict-safe tombstones for deleted entities.

### Phase 3: realtime project sessions

- Subscribe open project pages to backend project channels.
- Apply accepted remote mutations into IndexedDB and React state.
- Show lightweight presence: who is currently in the project.
- Surface sync status per project.

### Phase 4: conflict and audit UI

- Add edit history for checkpoint status, comments, and project metadata.
- Add conflict prompts where latest-wins is not acceptable.
- Add role controls and member removal.
- Add admin recovery tools for stuck pending mutations.

## Decisions still needed

- Backend platform: Supabase/Firebase/Convex/custom Next.js API plus Postgres.
- Shared media storage: Supabase Storage/Azure Blob/Vercel Blob/S3/SharePoint.
- Whether outside users can join projects or only UAI tenant users.
- Whether `viewer` and `editor` are enough for the first release.
- Whether first release can use latest-wins comments or needs conflict UI immediately.
