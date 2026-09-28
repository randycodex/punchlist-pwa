# Active phone/computer test environment

Created September 25, 2026 with authorization to keep a temporary test app and database available while the owner tests them. Delete these resources after the owner finishes; this is a new environment, distinct from the previously deleted backend-verification project.

- App: https://punchlist-device-test.vercel.app
- Latest verified deployment: `dpl_GB9NLfFtBfMAoUJyMCN6t5K2uQRr` (READY, September 27 offline repair). Original September 25 deployment: `dpl_6i6eDGWiDEhpxs2ooDwAyyYuEz57`.
- Vercel project: `punchlist-device-test`, `prj_JEf9um26VMzPMMlu4rZofncvSEIe`, team `team_9EJNb6mc4ZUQ5bhRcRhmoBRR`.
- Supabase project: `punchlist-device-test`, `yuaqxwlgcjohcbynimkf`, us-east-2. All 40 migrations applied.
- Disposable project: **PHONE + COMPUTER TEST**, with units 101 and 102.
- Sign-in dropdown: **Test inspector** on both devices for same-account device-lock tests; **Test teammate** for a second-member test. The random test password is provided privately in the task response and is not included in this repository.
- Temporary isolated build workspace: `/tmp/punchlist-device-staging/app`. This may disappear after a host cleanup/restart; the deployed app remains available.

## Build differences and isolation

The deployed source is the `abfb7e1` snapshot plus the first-download timestamp fix committed with this record. The preexisting uncommitted manualSharedPull edit and output directory were not published. The test-only overlay is retained in `device-test-overlay-2026-09-25.patch`. Apply it with `git apply --unidiff-zero` only to a disposable copy, never to the live app.

The overlay replaces Microsoft sign-in with actual Supabase password authentication for two disposable users, displays a yellow TEST APP banner, renames the PWA to PUNCHLIST TEST, and stops the home Sync action after the normal team-sync flow so it never contacts real OneDrive. Claims, release, team publication, storage, local saves, and recovery use the application code and real test backend. The app bundle contains only the test public anonymous key; no database password or service-role key is deployed. Production app settings, domains, and database linkage were not changed.

This setup does not verify Microsoft OAuth or OneDrive backup/restore. Those require separate acceptance. Browser viewport checks are not physical-phone acceptance.

## Verification

- New Next.js Vercel project is deployed and reachable without a Vercel login at the stable app URL.
- Test sign-in works in a fresh isolated browser profile.
- Sync All Projects downloads the seeded team project and reports successful team sync.
- Opening unit 101 claims the area; entering a general note and clicking Release uploads the note and returns to the project.
- Direct read-back from the test database confirmed the exact note, area version 1, and zero active claims after release.
- Mobile viewport 390 x 844 shows the yellow label and both areas. Browser runtime-error collection was empty.
- The original full local suite still passes 356 tests; lint and build pass after the first-download fix. The test overlay separately passes lint and the hosted Next.js build/typecheck.

The browser test left this harmless note in unit 101: “Staging browser check: note saved and synced.” Unit 102 is available for a clean test.

## Owner test sequence

1. Open the app URL on phone and computer. Choose Test inspector and enter the supplied password on both.
2. Click Sync All Projects, dismiss the result, expand Floor not set, and open unit 102 on the phone.
3. Add a unique note and three photos. Wait for saved confirmation. Close/reopen and verify exact content.
4. Repeat offline after first opening the project and area online; reconnect afterward.
5. While the phone holds the area, check that the computer cannot take or release it. Sync/release on the phone, then open it on the computer and verify the note/photos.
6. Use Switch test account to test with Test teammate separately. Do not put real project data into this temporary environment.

## Cleanup after testing

Delete only Vercel project `prj_JEf9um26VMzPMMlu4rZofncvSEIe` and Supabase project `yuaqxwlgcjohcbynimkf`, then confirm they no longer appear in project listings. Preserve the actual production projects (`prj_2iCX8Z76vQJXsfO7Jhebj2OEZ7V5` and `wwutemmdbimzucrijckg`). Remove the local temporary workspace/credentials after capturing any required test evidence. No automatic deletion is scheduled because the owner's test completion time is unknown.

## Offline area repair — September 27, 2026

The original app registered the offline worker but never invoked project-page preparation. The hosted cache contained only `/`; saving project data did not cache its area documents. Online navigations also were not retained. Automatic preparation now runs on startup, reconnect, focus, worker activation, and completed local saves. It checks actual cache entries, downloads missing project/area pages in bounded batches, repairs missing assets, excludes removed records, and displays preparation progress/errors with a retry action. Same-build HTML navigations are retained without mixing newer deployment HTML into older bundles.

Build asset URLs now encode individual path segments. A server-stopped webpack browser check exposed unencoded `[id]` and `[areaId]` filenames that otherwise prevented the cached area page from hydrating.

Verification: 359 tests passed; lint and typecheck passed. A production-mode isolated test build automatically cached home, project, and both area routes after team download, before visiting either area. With its local server stopped and browser networking disabled, an unvisited area rendered, reloaded, returned to its project, and opened the second area. The 390×844 rendered area was inspected; no browser runtime errors were collected. No test notes, photos, or remote area claims were added by this offline check. Physical phone acceptance remains pending.

Updated phone sequence: reconnect, reload the test app to download its update, then close all its tabs/windows and reopen online if it reports a waiting update. Wait for **Saved pages ready offline** after syncing the project. Enable airplane mode and open either saved area, including one not previously visited, then reload it. This status verifies page availability; separately test the saved photos, notes, and reconnect delivery. Do not clear browser storage. Keep this temporary environment until the owner completes testing.

Deployment verification also caught a locally generated worker uploaded with a different build ID. `.vercelignore` now excludes local outputs and credentials, including `public/inspection-sw.js`, so the hosted build supplies its own matching worker. The final stable alias serves matching HTML/worker build `79c6dc4b-bc5c-4449-88d5-8da37be7bf52` with 42 assets.

Final hosted browser verification: after sign-in and team download, the readiness status appeared automatically and the current cache contained all 42 assets plus home, project, and both areas (46 entries). Opening an area and reloading with browser networking disabled succeeded; runtime-error collection was empty. The separate server-stopped local check above establishes actual cache fallback, since browser network emulation alone may not disable service-worker network fetches.

## Recovery acceptance — September 28, 2026

Owner-reported phone checks passed in the test app: offline area opening/reload; note persistence; force-close after saving; immediate force-close after entering a checkpoint note; photo persistence after force-close once its thumbnail appeared; exactly one photo opening full-size offline; and subsequent delivery of the new item, checkpoint, note, and photos to the computer without duplicates. The attempted manual interrupted-sync check finished before disconnection, so it is not counted as an interruption pass. These observations apply to the owner's tested phone/browser, not every platform or storage-pressure condition.

A separate isolated-browser check created `INTERRUPTED SYNC CHECK`, shared project `532deac4-7f13-49c5-9e9e-6ce9f4b65940`, local project `fb0a1a57-8875-4ace-b785-af2bfe1e5ee9`, area `87b11003-b8d3-4b24-b4a3-349f1dd9017b`. After establishing its initial team snapshot, a temporary browser-only fetch wrapper threw a connection error before `publish_shared_project_area_snapshot`. Ten publication attempts were intercepted while the note and two test images were saved. One durable queue record remained. Release displayed “This area still has changes waiting to reach the team. Its lock is staying with you.” The ordinary network route command alone was not counted as evidence; the wrapper's interception counter and app queue/UI established the failure.

After disabling the fault and retrying Release, the sender returned to its project and the queue reached zero. A fresh browser signed in and downloaded the project from the hosted test backend. The note matched exactly (`Interrupted sync verified note 2026-09-28`), and both photo IDs appeared exactly once. Stored full-image bytes matched sender/receiver:

- `568f9232-0aaf-43de-8b25-c22baa025adf`: 6812 bytes, SHA-256 `80a677e891fbab766901cd6682d6bcb202aa7d5e543c8a30a90cee88845c293f`.
- `91c8f5e7-59e9-45db-b8cd-d529d1eb731c`: 4022 bytes, SHA-256 `701838b17ac1c3aa1bd85edbe446e5671b27d476686f2b113232a0089626f10d`.

The receiving browser then acquired and released the area successfully. Both isolated browser sessions were closed. The disposable project remains in the temporary environment for audit/cleanup with that environment. The owner's existing phone-test project was not edited. This verifies publication failure before server acceptance and subsequent retry, not a dropped acknowledgement after server commit, interruption mid-photo upload, physical low-storage behavior, or lost-device owner recovery. Production and app source were unchanged by this test.

## Lost-device owner recovery — September 28, 2026

Nine authenticated hosted RPC checks passed against the isolated test backend, using the existing disposable owner/member accounts and a new `LOST DEVICE RECOVERY CHECK` project (`a0ced569-de89-4ff2-ae20-57b5beb75fab`). No service-role credential was used. The verification script and structured result are retained temporarily under `/tmp/punchlist-device-staging/verify-owner-recovery.mjs` and `owner-recovery-result.json`; neither contains authentication tokens or passwords.

1. An ordinary member cannot use owner recovery, even for their own other-device claim (`42501`).
2. An incorrect area/claim pairing releases neither lock.
3. The owner can release the exact abandoned member claim while preserving an unrelated area's claim.
4. Another device can claim the recovered area.
5. Repeating the old recovery request returns false and preserves the replacement claim.
6. The former device cannot publish while the replacement device holds the lock.
7. Published snapshot contents remain identical after recovery and rejected stale publication.
8. The owner can also recover their own other-device claim.
9. Final cleanup confirms zero active claims in this verification project.

This establishes hosted permission, identity, and stale-request behavior. It does not constitute a rendered owner-menu test or recover unsent data from an unavailable physical phone. The test project remains disposable and can be removed with the temporary environment. The owner's phone-test project and Production were untouched. Storage-pressure verification remains outstanding.
