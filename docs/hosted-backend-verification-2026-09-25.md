# Hosted backend verification — September 25, 2026

## Result

24 hosted checks passed against disposable Supabase project `backend-sync-verification` (`zxkweijtnxuepahvwltp`, us-east-2). The complete 40-file migration chain applied successfully, including all four migrations pending in Production. Auth users were created through the admin API with confirmation enabled; no verification emails were sent. Tests used real authenticated PostgREST and Storage requests.

A preview-branch creation was rejected with HTTP 402 because branching requires Pro. An independent temporary project was used instead; no organization plan upgrade was performed and no production data was copied.

## Passed checks

1. Disposable confirmed accounts authenticate without sending email.
2. Create project and publish initial snapshot through PostgREST.
3. Second account joins disposable project.
4. Phone claim retries retain claim identity.
5. Same-account computer cannot take phone lock.
6. Same-account computer cannot release phone lock.
7. Legacy release RPC cannot bypass device guard.
8. Wrong device cannot publish.
9. Area publication and idempotent retry accepted.
10. Stale release version returns HTTP 409.
11. Accepted-version release and retry succeed.
12. Old release retry preserves replacement claim.
13. Direct collaboration table mutations denied.
14. Outsider and anonymous requests cannot access project.
15. Owner recovers abandoned device claim.
16. Member uploads storage object.
17. Storage overwrite and upsert denied.
18. Outsider cannot read stored attachment.
19. Original attachment content remains readable.
20. Member storage deletion cannot remove object.
21. Concurrent devices produce exactly one claim winner.
22. Concurrent same-base publication accepts one and rejects the other.
23. Twenty parallel authenticated snapshot reads succeed.
24. Attachment cleanup report remains owner-only.

## Cleanup

The CLI confirmed deletion of project `zxkweijtnxuepahvwltp`. A subsequent project listing contained only the original healthy `punchlist` project. Local temporary database-password and API-key files were removed. The workspace remained linked to the original project throughout; migration application used an explicit staging database URL.

## Reproduction

`scripts/verify-hosted-backend.mjs` runs the HTTP acceptance scenarios. It requires an explicit `PUNCHLIST_TEST_PROJECT_REF`, a private `PUNCHLIST_TEST_KEYS_FILE` containing the output of `supabase projects api-keys --output json` for that disposable project, and `PUNCHLIST_DISPOSABLE_TEST_PROJECT=yes`. Apply the migration chain before running it. The harness refuses the known Production project and creates disposable users, projects, and objects; delete the test project afterward. Never commit API-key files.

The successful run used the same harness logic before its credentials and project selection were parameterized for reuse. Earlier harness attempts were corrected for the snapshot RPC parameter name, a no-op PATCH, required PATCH filters, and the membership column name. These were harness errors, not application fixes. The final run explicitly required database permission code 42501 for direct table mutations.

## Evidence limits

This is fresh-project migration and hosted API/storage evidence. It does not prove migration behavior against a copy of existing Production data, Microsoft sign-in through the rendered app, real OneDrive behavior, physical-phone capture/force-close recovery, installed-PWA updates, or sustained high-load performance. The parallel-read check is a 20-request smoke test, not a capacity benchmark. Production deployment has not occurred. Phone/computer acceptance and a coordinated release remain outstanding.
