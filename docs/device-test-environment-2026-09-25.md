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
