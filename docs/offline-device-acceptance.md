# Offline and capture-recovery acceptance

Use a disposable personal project first. Shared-area offline editing is intentionally unavailable until a server-confirmed reservation design is implemented.

## What this branch verifies locally

- Production build precaches versioned app bundles; Prepare for site visit downloads the project's document routes and checks local media availability.
- Cache checks inspect the actual stored pages and assets. An interrupted worker installation preserves the previous version; an update downloads previously prepared pages before replacing them.
- In the desktop browser, the project page, Resume navigation, and a fresh inspection tab loaded with the local HTTP server stopped. This is a server-unavailable test, not proof of installed iPhone or Android behavior.
- Regression tests interrupt the canonical inspection transaction after durable capture journaling, then reopen the journal and restore notes/photos. They also cover changed notes, repeated recovery, stale revisions, and duplicate photo IDs.

## Physical phone acceptance still required

For each supported iPhone/Safari and Android/Chrome version, run in both browser and installed-app mode. Record OS/browser version, starting note text and photo IDs/counts, and the result after reopening.

1. While online, Get Team Updates if appropriate, then Prepare this project. Resolve missing media before leaving. Voice transcription needs its separate model download and is not certified ready by this check.
2. Enable airplane mode, close the app, reopen it, and open the prepared project and several areas. Confirm room/item context, notes, photos, drawings, and files remain accessible.
3. Type a unique note and take three distinguishable photos. Wait for the saved indicator, force-close, reopen, and confirm the exact text and exactly three photos.
4. Repeat termination during typing and immediately after the shutter. Open the same area and review any recovery records. A capture is protected only after its journal transaction completes; an image not yet captured or a write rejected by full storage cannot be guaranteed.
5. Restore retained captures twice, including after a newer note was entered. Confirm no photo duplicates and that newer note text remains intact.
6. Test low-storage/quota failure. The UI must retain an unsaved warning. After space is available, retry and verify the saved record and team queue. Do not deliberately fill a personal phone's storage; use a dedicated test device/profile.
7. Reconnect. In a configured team test project, confirm claims, expired sign-in, conflicts, retry behavior, and delivery with a second inspector. A cached shared area must remain blocked without a confirmed lock.
8. Prepare a project, introduce an app update, and interrupt its download. The old prepared version must reopen. Finish saving and close all app tabs to activate a completed update; verify prepared routes still open afterward.
9. Compare repeated finding capture and room transitions with the previous app using the same inspection script. Record tap counts and elapsed times before claiming a speed improvement.

No physical-device pass, camera-permission pass, live team-delivery pass, or inspection-speed percentage is claimed by the local checks.
