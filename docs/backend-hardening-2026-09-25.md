# Backend reliability hardening — September 25, 2026

Implementation and verification are local. No hosted database migrations, Production deployment, or physical-phone acceptance were performed.

## Findings and changes

| Review finding | Implemented change | Verification |
| --- | --- | --- |
| Direct database writes could bypass guarded collaboration operations | Revoke direct mutation privileges on collaboration control/snapshot tables and restrict security-definer entry points | Real migration chain under authenticated PostgreSQL roles |
| Area deletion could release despite unsent changes | Project-scoped flush, queue recheck, retained-draft check, accepted-version check before release | Claim and queue regression tests |
| A computer could release the same account's phone locks | Persistent device identity; device-bound claim/publish/release RPCs; exact claim ID and version checks | Same-account/different-device SQL rejection and idempotent retry tests |
| An older pending-backup mirror could erase new work | Transactional revision tokens and acknowledgements of only the revisions captured before upload | Save-during-upload and scoped acknowledgement tests |
| Deleted media could return through backup merges | Photo/file deletion IDs survive parsing and are applied after merging | Deleted-photo merge tests in both directions |
| Missing media could be silently omitted | Required full images/files/drawings must have content or an existing reference; hydration fails on incomplete manifests | Manifest and missing-content regression tests |
| Syncing one project flushed unrelated projects | Optional local project scope is carried through both collaboration queues | Two-project scoped-flush test |
| Uploads could overwrite media used by older snapshots | SHA-256 content paths, immutable uploads, verification on download, append-only attachment metadata | Same-size/different-content test; storage write-policy SQL test |
| Local data was shared between signed-in accounts | Account-scoped databases, recovery journal, pending mirrors, settings, and asset cache; account mismatch blocks team requests | Account namespace tests; local browser creation/reload smoke |
| IDs and parent relationships were insufficiently checked | Imported payload validation; drawing storage uses project + drawing ID | Duplicate/parent rejection and copied-project drawing tests |
| General notes existed only in a debounce window | Journal each input before coalescing canonical saves; recover interrupted notes without erasing later text | Recovery test and browser note/reload smoke |
| Operational resilience and verification gaps | Cross-tab queue/local-write locks; blocked-upgrade feedback; disposable verified-media cache; owner-only cleanup report; real SQL migration tests; compatible dependency security updates | Full suite, lint, typecheck, build, dependency audit |

## Local evidence

- Initial verification: 69 test files, 318 tests passed, including the complete migration chain in PGlite with authenticated roles. This is PostgreSQL evidence, not a hosted Supabase/PostgREST integration test.
- ESLint, TypeScript, production build, and diff whitespace checks pass.
- Installed dependency audit: zero reported vulnerabilities at verification time.
- Isolated Chromium session against the local production build: created a project and unit, entered general notes, reloaded, and observed the same saved note. No browser runtime errors were reported. No external account or live team data was used.
- Follow-up fixed the short-window General Notes overlap by reserving layout space for the bottom navigation. Verified normal clicks and note editing at 1280×640 and 390×667 in Chromium; measured that the content viewport ends at the navigation's top edge. This is responsive-browser evidence, not physical iOS acceptance.

### Follow-up findings

- Follow-up verification: 70 test files and 323 tests passed; lint and the production build (including TypeScript) passed.
- Auth initialization failure now selects the last local account workspace before mounting storage consumers; offline namespace regression coverage added.
- Browsers without Web Locks now serialize same-name operations within the tab, including after a failure. Cache eviction and insertion use the same locking helper so concurrent downloads cannot overfill the cache.
- Drawing IDs now share the duplicate-attachment validation namespace with photos and files, matching their remote storage directories.
- Added legacy drawing-byte upgrade coverage and database tests denying unrelated authenticated users project/media access and guarded operations.
- Read-only hosted inspection found one Supabase project (`punchlist`) and no staging branches. Production's migration history stops at `20260923160000`; the earlier `20260923200000_owner_area_lock_recovery.sql` is also pending. There are **four pending migrations**, including that prerequisite and the three new hardening migrations. No hosted migrations were applied.

### Publish acknowledgement race

Full-project publication previously saved the uploaded in-memory project back over the durable local record. Edits made while attachment/network work was running could therefore disappear. All five publish acknowledgement call sites now use a transaction that updates only accepted collaboration markers, preserves current local contents, and queues area/metadata differences for another send. An acknowledgement rejects a removed or relinked local project instead of resurrecting it. Final sync verification also checks for new queue records before reporting success or releasing locks.

Regression coverage reproduces a note and project rename during the first baseline upload, unchanged baseline acceptance, deletion during upload, and newly queued work before release. The suite passes 327 tests in 70 files; lint and the production build including TypeScript pass. Hosted network-race acceptance remains outstanding.

### Automatic download race

Automatic shared-project sync now captures the durable local state before its network work and checks that state inside the replacement write transaction. A changed local record prevents the downloaded project and its media from replacing current work; the result remains pending and no locks are released. Tests prove that a note and photo survive a rejected stale download and that an unchanged source permits replacement. This guard currently covers the automatic pull inside selected-project sync; other explicit restore/import paths still require separate review. Verification: 329 tests in 70 files, lint, and production build including TypeScript passed.

### Explicit download and backup restore

The ordinary Get Team Updates action on both project surfaces now uses the same stale-source guard. Backup restoration also checks the source captured before downloading. Its project/media replacement and clearing of old collaboration queues happen in one IndexedDB transaction, and the restored project is marked for personal backup. Explicit abort handling rolls back all writes if media persistence throws. Tests cover stale restore rejection, accepted restore queue reset, and an injected media-write failure preserving the original note and queued change. Verification: 331 tests in 70 files, lint, and production build including TypeScript passed. Reviewed merge confirmations, file imports, and personal-cloud download paths remain separate review items.

### Reviewed merge confirmation

Both confirmation surfaces now compare the current durable project metadata with the local source used to prepare the review. Changed work rejects the confirmation and remains saved. Accepted merges atomically persist the project/media and rebase preserved area queues, including their explicit next-sync review hold, plus any retained metadata queue. This removes the separate post-merge metadata write that could replace newer work. Derived checkpoint rules are normalized for comparison; JSON property order does not create a false mismatch. Regression coverage verifies rejection after typing during review and successful queue rebasing on a fresh review. Verification: 332 tests in 70 files, lint, TypeScript, and production build pass. File imports and personal-cloud downloads remain under review.

### Personal-cloud merge and media loading

The current personal-project merge, remote archive application, and explicit OneDrive media-loading paths now use transactional stale-source checks. Notes saved during photo downloads survive; the operation reports that another sync/load is needed instead of silently replacing current work. Regression tests reproduce both a note during direct photo loading and a note during a personal-cloud merge. Verification: 334 tests in 70 files, lint, and production build including TypeScript passed. Missing-project recovery, file imports, and older full-sync entry points remain separate review items; no real OneDrive account was modified by these tests.

### Missing-project recovery and backup identity

Missing-project recovery now inserts only if the local ID remains absent. Explicit inactive-team recovery atomically replaces its unchanged source and clears its old queues after preserving the recovery copy; concurrent local changes prevent replacement. Personal merge/archive also reject a cloud payload whose project ID differs from its filename. Tests reproduce a project appearing during restore and a mismatched backup ID. Verification: 336 tests in 70 files, lint, and production build including TypeScript passed.

Import-surface clarification: source inspection found CSV/TSV unit import in `AreaEditorModal`, but no general JSON project-file import UI. Full-project payload imports occur through OneDrive and team snapshots and use the validated payload parser. The older exported full-sync entry points remain a separate review item; ordinary current personal backup uses the newer merge/backup/recovery functions.

### Older sync entry points

Source search found no current UI callers of `syncProjectsWithOneDrive`, `pushProjectsToOneDrive`, or their recovery wrapper. Their folder-name persistence now uses the existing narrow field update instead of replacing the project. Full-sync download branches also use stale-source checks and reject filename/payload ID mismatch. Tests confirm a newly created local project survives a legacy download and no upload starts after that rejection; folder bookkeeping preserves a newer note and its pending backup marker. Verification: 338 tests in 70 files, lint, and production build including TypeScript passed. The only remaining unconditional whole-project save in OneDrive sync creates a separately identified recovery copy.

### Deletion failure recovery

Project deletion now explicitly aborts its main IndexedDB transaction on partial failure and cleans the separate capture journal only after the project/media/queue deletion commits. An injected media-deletion failure verifies that both the original project and its recovery note remain; retrying successfully removes both. The two databases cannot share one transaction: interruption after the main commit can leave orphan recovery drafts, which is preferable to losing drafts before a failed deletion. Verification: 339 tests in 70 files and lint passed; production build validation recorded with this commit.

### Late callbacks and device permission consistency

Checkpoint persistence rejects projects already in Trash and purged areas; general-note persistence also rejects purged areas. This prevents delayed inspection/recovery callbacks from changing deleted work. The shared edit-permission helper now requires a matching device for device-bound claims, and returned claim objects retain their device ID. Tests cover late callbacks and missing/wrong/matching device IDs. These are client consistency checks in addition to the server RPC enforcement; the helper currently has no app call sites.

## Coordinated rollout required

1. Back up the hosted database and record the current app release. Inspect existing grants, attachment paths, and active claims for drift from the migration chain.
2. Validate all four pending migrations and this app build together in staging. Old clients lose access to the old claim/release RPCs and cannot publish an area without a device ID. New clients require the new schema. Do not roll out either half independently to active inspectors.
3. Have active inspectors finish local saves and sync, then release locks before the maintenance/update window. Preserve pending local data and recovery drafts; do not clear browser storage to force an update.
4. Apply migrations in timestamp order, deploy the matching app, refresh installed PWAs, and verify the new diagnostic probes. Check client version adoption before reopening shared editing.
5. Run the acceptance scenarios below on the hosted staging stack before Production. Rollback must be assessed as an app/schema pair; simply reverting the app would strand old lock calls. IndexedDB version 9 also cannot be opened by an older version-8 client.

## Remaining acceptance and boundaries

- Test a physical phone and computer using the same account: claim on phone, deny computer editing/release, upload phone changes, release, then claim on computer. Repeat with different members, offline/reconnect, interrupted requests, and owner recovery.
- Test phone force-close/backgrounding while capturing photos and typing notes, storage pressure, blocked database upgrades, and recovery after restart. A completed browser reload is not force-close evidence.
- Test hosted PostgREST RPC exposure, storage upload retry/duplicate responses, account switching across tabs, large real projects, and concurrent publication/load. PGlite tests do not simulate distributed connection-pool contention.
- Browser locks serialize operations where supported. They do not turn all whole-area saves from stale tabs into conflict-free merges; simultaneous editing of the same area in multiple tabs remains unsupported. Browsers without Web Locks retain existing in-tab/IndexedDB safeguards.
- The first sign-in adopts legacy anonymous local data when no remembered owner exists. Existing data cannot be retrospectively attributed with certainty. Signing out retains the last workspace for offline use; account partitioning is not device encryption or a signed-out privacy lock.
- A legacy user-only claim is adopted by the first explicit upgraded claim from that user. Lost-device recovery is an explicit project-owner action, not automatic expiry.
- SHA-256 checks protect newly hashed media. Legacy references remain readable and do not gain invented checksums. Missing-media failures preserve the local project for recovery.
- Cleanup is a read-only owner report of metadata older than seven days. All current snapshots and historical backups protect references; unknown payload versions prevent candidates. No automatic deletion or retention policy is enabled, and storage objects without metadata require separate inventory.
- Cache contents are disposable; durable offline inspection data remains in IndexedDB. Clearing browser/site data still removes local-only work.

## Scope preserved

The pre-existing edit to `src/features/collaboration/manualSharedPull.ts` and pre-existing `output/` files are excluded from this implementation commit. Local verification ran against the working tree, including that existing edit.
