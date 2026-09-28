# Production release preparation — September 28, 2026

Status: prepared candidate, not deployed. Production rollout requires a save/sync/release window and final approval. Real Microsoft/OneDrive end-to-end acceptance remains deferred, not passed.

## Candidate and existing release

- Candidate application source: `ea3c0515fa116385a85310f0aba2ee3cbeb06eeb` on `codex/backend-sync-hardening`.
- Clean source archive: `/tmp/punchlist-release-20260928`, excluding the pre-existing manualSharedPull edit and untracked output directory. Temporary files may not survive machine cleanup.
- Verification on that clean archive: 359 tests in 72 files, lint, typecheck, and production build passed. A second local build passed, but Vercel replaced four sensitive environment values with placeholders during export, so it is compilation evidence only. The remotely built, unpromoted candidate is the configuration-authoritative artifact. Environment files are private and excluded from Git/deployment uploads.
- Current production app: `dpl_8s6Unzj2CEQc1RW47MUUkDAeqUnA`, `https://punchlist-cud0kl8ek-randycodexs-projects-b72fc111.vercel.app`, aliased at `https://punchlist-pwa.vercel.app`.
- Production Vercel project: `prj_2iCX8Z76vQJXsfO7Jhebj2OEZ7V5`; Supabase: `wwutemmdbimzucrijckg`.
- Production database migration history ends at `20260923160000`. Read-only queries confirmed the device claim RPC is absent and authenticated direct UPDATE privileges still exist on claims and snapshots, consistent with the pre-hardening schema.
- Production currently has 78 active claims held by 6 users and 9 non-archived projects. All 78 claims are more than one day old. This is a point-in-time count, not proof of active editing or safe abandonment. Do not bulk-release them without owner review and confirmation that local work is safe.

## Exact pending migration order

1. `20260923200000_owner_area_lock_recovery.sql` — SHA-256 `a23ae5ddda9abfccf12622bc26ab19149c7854134594add1972e5ebdec3f962b`.
2. `20260925170000_protect_collaboration_writes.sql` — SHA-256 `3b22dbf4ac0c1e6a07b8fb9845fe8e4e165f2fd5a0798b435220269c7583247a`.
3. `20260925171000_device_area_claims.sql` — SHA-256 `31bdff6fa8b386fb2ab2416bbed1454cd806cd074d556b9f69d0cc7030092adc`.
4. `20260925172000_immutable_attachment_objects.sql` — SHA-256 `d118d05ffc2ecc03b8cb2c0ebfb205572b962525d84c57eb37d0121455499447`.

## Execution sequence after approval

1. Confirm all inspectors have finished local saves, synced pending work, and released areas. Recheck active claims and inspect any remainder with the owner. A server cannot prove that disconnected phones have no pending work.
2. Refresh the database backup immediately before the maintenance window. Keep the existing deployment identity and verified migration checksums. Verify production linkage again.
3. Build the clean candidate using production settings. Prepare its Vercel deployment without assigning the live domain, inspect successful build output, and verify matching HTML/service-worker IDs before promotion. Do not accidentally include the disposable password-login overlay or test backend.
4. Apply exactly the four pending migrations in timestamp order during the coordinated window, recording their history. If any migration fails, stop and inspect which transactions committed; do not blindly retry the whole set or promote the app.
5. Promote the matching app to the production alias. Verify migration history, RPC availability, direct-write rejection, and the worker/page build match.
6. Have inspectors close and reopen app tabs online, then wait for saved-page readiness. Verify one authorized disposable live project through note/photo save, sync, lock release, and another device download. Keep regular editing paused if either app/schema checks fail.
7. Retain the temporary test environment until live acceptance. Remove only its documented resources afterward.

## Recovery limits

Before database changes, the previous production deployment remains the fallback. After applying the new schema, do not roll back only the app: the previous client uses incompatible lock calls. Prefer fixing forward with the matching client while editing remains paused. Database restoration requires an explicitly reviewed restore procedure and a reconciliation plan for any writes made after the backup; it is not a one-click application rollback. IndexedDB version 9 also cannot be opened by a version-8 client. Never clear browser storage to force adoption.

The earlier hosted and physical-device evidence is recorded in `device-test-environment-2026-09-25.md`. It does not certify real OneDrive behavior, all device/browser combinations, mid-transfer acknowledgement loss, or an actual full-device disk condition.

## Coordination

The owner confirmed that all inspectors have saved and synced and can stop editing for the release window. This does not itself release the 78 existing database claims. Recheck them before deployment and resolve remaining claims explicitly; do not infer abandonment from age.

## Prepared hosted candidate and backup

- Candidate deployment: `dpl_2kkE8UGkLdFmjnsgTmN3X8vLzddu`, `https://punchlist-c9ivpoiy0-randycodexs-projects-b72fc111.vercel.app`, READY. Built remotely using actual production environment values via `--prod --skip-domain`. Protected candidate HTML and worker were retrieved with Vercel's authenticated curl; both report build `2cec6519-abc3-43c7-81d3-180d95342934` and the worker lists 42 assets. This is build/HTTP evidence, not authenticated production workflow acceptance.
- `punchlist-pwa.vercel.app` was re-inspected and still resolved to `dpl_8s6Unzj2CEQc1RW47MUUkDAeqUnA`. Despite `--skip-domain`, Vercel assigned its secondary `punchlist-pwa-randycodexs-projects-b72fc111.vercel.app` alias to the candidate. That alias was explicitly restored to the old deployment; the CLI confirmed successful restoration. No database migration was applied.
- Supabase's physical-backup list returned no available backups and PITR disabled. The CLI Docker-based export failed because Docker/Podman was unavailable. Installed Homebrew libpq and used native pg_dump with temporary CLI credentials instead. The first native attempt failed authentication after the temporary login credentials changed; refreshing them and rerunning succeeded.
- Successful private logical export: `/Users/randy/.codex/backups/punchlist/2026-09-28/production.dump`, 348834298 bytes, PostgreSQL custom archive. Includes schema and data for `public`, `auth`, `storage`, and `supabase_migrations`. Directory/file permissions restrict access. It contains sensitive production data and must never be committed or uploaded with the application.
- This is a logical database backup, not a copy of Storage object bytes, platform configuration, or any phone's local-only data. A restore to a database has not been rehearsed. Refresh it immediately before a later release if any writes have occurred.

The archive's full contents were successfully decoded with `pg_restore --file=/dev/null`; its index was also read. SHA-256: `76c67b269d24e251fb219f10b8ec3543ee4fa4ef29b0e5ea0aede19e5f5ed7ef`. This validates archive readability, not a tested database restore.

Final active-lock recheck still returned 78 claims across 6 users after the owner's sync/pause confirmation. Release execution remains on hold pending ordinary claim release or explicit owner-reviewed recovery of the remaining claims, followed by final rollout approval. Do not mark this release as deployed.
