# Backend readiness work — October 3, 2026

Changes are local candidates based on `bb8356678ca222aba6d682d22b38187779172e07`. No production configuration changes, new credentials, private production export, live acceptance writes, cleanup or retention job is part of this work.

## Dependency findings and release gate

Registry audit on October 3 returned five high dependency nodes caused by one advisory: [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), stack exhaustion from deeply nested brace patterns. Installed path is `eslint-config-next@16.3.6 -> @next/eslint-plugin-next@16.3.6 -> fast-glob@3.3.1 -> micromatch@4.0.8 -> braces@3.0.3`. The full report names all five ancestors/dependencies; these are not five independent application vulnerabilities.

`npm audit --omit=dev --json` returned zero findings. Source/config inspection found this path used by the development lint toolchain; application code does not accept user-supplied glob patterns through it. Malicious deeply nested lint glob configuration remains relevant to development/CI, especially untrusted changes. This exposure assessment does not remove the advisory or guarantee an absence of other vulnerabilities.

The registry's latest `braces` is 3.0.3, and the primary advisory lists no patched version. npm suggests downgrading `eslint-config-next` to 14.2.35 as a semver-major change. That would mismatch the Next 16 application and lint APIs; it was not applied. No unrelated package upgrade or forced audit fix was used. Continue to treat glob/config changes as executable review input, and recheck for an upstream compatible fix before release.

- `npm run audit:production`: high/critical production dependency gate.
- `npm run audit:all`: includes development dependencies; intentionally remains failing while this advisory is unresolved.
- `npm run verify:release`: full tests/lint/typecheck/build followed by both audit gates. A passing local build alone is not release approval. Resolve or explicitly review the advisory before overriding a failed release gate; do not quietly suppress it.

## Safe local acceptance

`npm test` includes mocked Microsoft/Graph failure paths, real embedded PostgreSQL multi-device claim/publication guards, immutable upload reconciliation, idempotent backups and the synthetic database/photo recovery rehearsal. `npm run recovery:rehearse` repeats recovery alone. Tests do not log into Microsoft, create hosted accounts or mutate production. See [recovery-runbook.md](recovery-runbook.md) for backup coverage and [storage-limits-and-inventory.md](storage-limits-and-inventory.md) for the proposed settings, compatibility limits and read-only reporting.

## Hosted acceptance still requires approval

The hosted backend harness creates synthetic users/projects/objects, exercises denied writes and attempts object deletion to prove policy enforcement. It is **not read-only** and was not run against a hosted service during this work. `scripts/lib/hostedAcceptance.mjs` rejects the production ref before reading credentials or sending requests. It additionally requires a valid ref, `PUNCHLIST_DISPOSABLE_TEST_PROJECT=yes`, an existing private `PUNCHLIST_TEST_KEYS_FILE`, and `PUNCHLIST_HOSTED_WRITE_APPROVED` equal to the exact separately approved disposable project ref. These environment flags record a decision; they do not grant authorization by themselves. Never point the harness at another real-data project merely because it is not the known production ref.

After separate owner approval for an isolated target and its existing private credentials, run `node scripts/verify-hosted-backend.mjs` only there. The harness now checks the current idempotent backup RPC returns one history row on retry and an immutable duplicate upload preserves hashed bytes. Every request and response-body read has a 30-second bound. Timed-out writes are not blindly replayed; their outcome may be unknown. Record source revision, target identity, app/schema versions, run date, failures and remaining synthetic users/objects for subsequent separately authorized cleanup. Do not commit keys/results containing tokens or private contents.

A hosted Supabase harness cannot certify Microsoft consent, MSAL refresh, actual OneDrive operations or a physical device. Obtain separate authorization for disposable Microsoft accounts/files and device actions, then verify:

1. Ordinary reconnect uses the same selected account; explicit account switching still selects an account. Confirm scopes/consent remain unchanged. Run beyond token expiry; a rejected request should silently refresh once or report legitimate reconnect, preserving local pending work.
2. Save a note/photo, send the chosen team area, confirm release only after its accepted revision, and download on a second device. Race same-base publications and interrupt acknowledgements; verify one accepted revision/idempotent history ID and intact local edits.
3. Back up/export to OneDrive, download/import, and compare every photo's bytes. Interrupt download/upload, simulate throttling and expire a lease. Conditional writes must not be blindly replayed after ambiguous transport failures, and local backup acknowledgement must wait for confirmed success. A cancellation signal is supported by the transfer layer; no new Cancel button was added.
4. Verify realtime notification delivery across devices, not just joined channel state. Diagnostics intentionally distinguish guard availability, pending queues and channel state from successful end-to-end operations.
5. Rehearse managed database/object recovery using the approved coherent bundle and isolated target. Browser IndexedDB, managed Auth/Storage serving, actual Microsoft files and post-backup write reconciliation remain separate acceptance evidence.

Production backup/PITR/size settings, paid plans, credential creation, external sign-ins, hosted writes, deletion/cleanup, promotion and pushing this candidate require their respective approvals. This local work does not establish that October's errors were caused by a particular app path.

## Completed local verification

Final `npm run verify` passed: **547 tests in 92 files**, ESLint without findings,
TypeScript and Next.js production build. The offline worker contains 44 versioned
assets, build `18c4fbec-4f2a-43f6-a704-7d753c3609b1`. This used local `.env.local`
and is local compilation evidence, not a deployed/configuration-authoritative or
signed-in hosted acceptance result. `git diff --check` passed. The production
advisory gate passed with zero findings; the full advisory gate failed with the
five development nodes described above. No dependency versions were changed.

The source remains an uncommitted candidate on `main`, based on and remote-checked
against `bb8356678ca222aba6d682d22b38187779172e07`. No migration was prepared or
applied. No commit, push, deployment, live sign-in, backup export or production
mutation was performed. Pre-existing untracked conflict copies/instructions/output
were preserved. Only read-only hosted project/backup/migration/bucket metadata and
aggregate object inventory were inspected.

Task file scope (23 files):

- Application: `src/lib/collaboration/diagnostics.ts`,
  `src/lib/collaboration/attachmentLimits.ts`,
  `src/lib/collaboration/sharedSnapshotAssets.ts`, `src/lib/oneDrive.ts`,
  `src/lib/oneDriveTransport.ts`, `src/contexts/MicrosoftAuthContext.tsx`,
  `src/app/page.tsx`.
- Release/report tooling: `package.json`, `scripts/verify-hosted-backend.mjs`,
  `scripts/lib/hostedAcceptance.mjs`, `scripts/storage-inventory.sql`.
- Tests: `tests/collaborationHealth.test.ts`,
  `tests/collaborationDiagnostics.test.ts`, `tests/sharedSnapshotAssets.test.ts`,
  `tests/attachmentLimits.test.ts`, `tests/oneDriveTransport.test.ts`,
  `tests/hostedAcceptanceSafety.test.ts`, `tests/recoveryRehearsal.test.ts`,
  `tests/helpers/recoveryStorage.ts`, `tests/storageInventory.test.ts`.
- Review documents: this file, `docs/recovery-runbook.md`,
  `docs/storage-limits-and-inventory.md`.

The first aggregate runs exposed a stale diagnostics test count and cold embedded
PostgreSQL startup exceeding the inventory test's default deadline. The diagnostics
mock now verifies exact current guards plus queue/realtime results; inventory
startup is in a bounded setup hook while its query test retains the ordinary
per-test deadline. Both passed in the final aggregate run. Final review also added
a regression for a late successful OneDrive write after an account switch; its
response cannot acknowledge the wrong workspace.
