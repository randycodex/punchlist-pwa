# Punchlist recovery procedure and local rehearsal

## Evidence and scope

October 3, 2026 read-only inspection of project `wwutemmdbimzucrijckg` returned `backups: []`, `physical_backup_data: {}`, `pitr_enabled: false`, `walg_enabled: true`, region `us-east-2`. This reports what the supported API exposed then; `walg_enabled` does not establish an available restore point. Hosted migration history includes `20261002195000`. Attachment bucket configuration is private with null size/MIME limits; avatars are private, limited to 2 MiB and JPEG/PNG. No production contents were exported in this work and no backup settings changed.

The September 28 release record remains historical evidence. Its private logical database archives were decoded, but their restoration into PostgreSQL/Supabase remains unrehearsed. Do not place those archives, credentials or photo copies in Git, deployment artifacts or the test fixtures.

Supabase [database backup documentation](https://supabase.com/docs/guides/platform/backups) confirms that database backups contain Storage metadata, not object bytes. A database-only recovery cannot reconstruct missing photographs.

## Reproduce the safe rehearsal

From the repository checkout run:

```sh
npx vitest run tests/recoveryRehearsal.test.ts
```

No credentials, network, Docker or hosted account are required. The test creates fresh embedded PostgreSQL with all repository SQL migrations and minimal local Supabase auth/storage surfaces. It creates a synthetic project, member, version-2 snapshot, idempotent recovery history, attachment metadata and a decodable one-pixel PNG. It writes an embedded database archive, object bytes and a SHA-256/size manifest to an OS temporary directory, closes the source database, loads the archive into a fresh database and copies objects to a different directory. It compares all seeded rows (including complete private bucket configurations) and the actual PNG bytes. Both the restored current snapshot and historical recovery payload use the real version-2 envelope produced by the app. The app parser and asset hydrator resolve each restored photograph from disk and reproduce the original image data URL. Separate tests reject missing or same-size corrupted bytes and unsafe/duplicate manifest paths. Cleanup removes only the directory created by this test.

This checks application migration compatibility, embedded PostgreSQL archive restoration and the need to restore matching photo bytes. It is **not** a `pg_dump`/`pg_restore` test, managed Supabase restoration, Storage HTTP upload test, authentication recovery, production backup validation or physical-device acceptance. No claims about hosted recovery time or maximum possible data loss follow from it.

## Backup bundle needed for real recovery

An approved recovery bundle must contain all of the following, tied to the same maintenance window:

- A readable database archive with schema/data and a manifest of migration versions, PostgreSQL/extension versions, archive checksum, project identity and capture times.
- Every required Storage object byte file, including attachment versions referenced by current snapshots and historical recovery points, plus avatars and any other bucket inventory. Include objects without current attachment rows; they may be referenced by older history or represent an incomplete registration. Record bucket, exact object key, byte size, content type, SHA-256 and original metadata. Do not limit inventory to the first listing page or only current active metadata.
- Bucket configurations (private/public, limits, MIME allowlists), Storage policies, Auth/provider/redirect configuration, Realtime publication/configuration, functions/triggers/grants, and application build/environment **names**. Preserve required secret values separately in the owner's secure credential system; never print them in logs or manifests.
- A capture/reconciliation record covering queued local-only device changes, in-flight publications and uploads. Database and object copies are not inherently one atomic snapshot. Pause editing/uploads during a coordinated capture or implement and verify a consistent inventory/copy/recheck protocol. Preserve phones' IndexedDB and recovery copies; do not clear them.

Record missing bytes explicitly rather than calling the backup complete. Encrypt private bundles, restrict permissions, keep an independent copy, and agree on backup cadence/recovery-point and recovery-time targets with the owner. Choosing PITR or another paid plan requires a separate approved decision; PITR still does not replace object-byte backup.

## Reviewed restore sequence (requires separate authorization)

1. Establish the target and maintenance window, stop new writes, preserve local work, and record the last accepted state. Do not restore over production as a first rehearsal. Obtain a separately authorized isolated Supabase/local-stack target and owner-approved private bundle/access; none was created by this change.
2. Verify archive readability/checksum and object manifest completeness before writing the target. Check every object size/hash, including historic references. Inspect PostgreSQL versions, available extensions and managed schemas. Determine which Supabase-managed auth/storage objects require platform-supported handling; do not blindly replay a full archive into an existing managed project.
3. Restore schema/data using the current supported Supabase restore/migration procedure for that target. Record exact tooling and committed steps; stop on errors instead of continuing a partially restored target. Reconstruct bucket settings and policies without widening access.
4. Restore object bytes through the target's supported Storage interface with exact bucket/keys/content types and immutable semantics. A restored `storage.objects` row is not evidence that Storage can serve bytes. Resolve conflicts by comparing bytes/hash; do not overwrite an unknown differing object. Verify every copied object through Storage downloads and SHA-256/size, then reconcile snapshot/history attachment references and inventory counts.
5. Verify project membership/RLS and grants with owner/member/outsider fixtures, current idempotent backup RPC, locks/claims, snapshot/history metadata and payload counts. Historical active claims need explicit owner/device reconciliation; age alone does not justify release. Recheck Auth providers/redirects, session behavior, Realtime subscriptions, and correct matching app/schema version.
6. With approved disposable target accounts/project, rehearse note/photo save, publish, backup, restore and another device download; verify historic photo download and immutable conflict behavior. Rehearse OneDrive backup/import separately with authorized Microsoft accounts. Measure elapsed restore time and account for accepted writes since capture. Keep ordinary production editing paused until the owner accepts reconciliation.
7. Only after successful isolated rehearsal and explicit production approval, select production cutover or restoration. Record outcome, remaining gaps and rollback/fix-forward plan. Keep original bundles and source devices intact; no history/object cleanup belongs to this procedure.

## Remaining access and configuration decisions

The local rehearsal is complete; a full managed restore still needs an approved isolated target, appropriately authorized backup/object access, a coherent private backup bundle and a production-compatible platform restore procedure. Production photo export, creating credentials/resources, changing PITR/plan/settings, live object/database writes, signing in external accounts, and production restoration were outside this authorization. The owner must choose recovery targets/cadence and approve those external steps before the procedure can establish actual recovery coverage. Existing API results do not show an available hosted backup or prove that the September archives plus missing Storage bytes meet those targets.
