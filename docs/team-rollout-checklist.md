# Four-person team rollout check

Run this on a **disposable shared project** using the owner and three separate member accounts on the phones and browsers the team will use. Keep production work out of the test project. Record each device, browser version, project ID, area IDs, issue/photo counts, and time of the last successful sync.

A Git branch or Vercel Preview isolates app code, but it does not isolate browser storage, OneDrive, or Supabase data. Confirm the preview's environment points to a separate test backend before exercising team recovery or intentionally creating conflicts. This repository currently has only the live Supabase project linked; a separate test project and four test accounts are required for a safe full rehearsal.

Before step 4, apply `20260923200000_owner_area_lock_recovery.sql` to the **test** Supabase project. The branch UI deliberately reports that the database update is missing if the owner tries recovery before it is installed. Do not apply this test migration to the live team database as part of a branch-only preview.

1. Owner invites three people. Each joins once, taps Sync Projects, and sees one team card with the same project ID and area count. Sign out and back in on one device; the project must reconnect without making a second card.
2. Two people inspect different areas and add distinguishable notes and photos. Both tap **Done · release** or Sync Projects. Everyone syncs and sees both sets of changes and unlocked areas.
3. Two people try the same area. The second sees the holder's name and cannot edit while the first holds a confirmed lock. The first releases it after delivery; the second can then enter.
4. Force-close one holder's app before release. The owner opens Team settings → Recover area locks, confirms the teammate is finished, and releases that exact claim. The teammate then reopens and syncs; any pending changes must remain available for conflict review.
5. Put one member offline while editing a shared area. Confirm their changes stay on the device, appear as pending, and are reviewed or merged when back online. No other person's changes should disappear.
6. Make one project need review, then sync with another team project and a personal project present. The unrelated team project should finish, and the personal backup should still run. The result must name the project needing review.
7. Simulate a OneDrive retry or sign-in delay. Team delivery and lock release must report their own result. The personal backup should remain queued without claiming that everything synced.
8. Restore or join a project that already has a local copy, including a trashed older copy. The directory must prefer the active copy. If divergent copies exist, **Review and merge copies** must preserve every area, checkpoint, photo, file, and team update before the extra copy goes to recoverable Trash.
9. On each device, search by exact unit, area name, and floor, then inspect the intended area. Test narrow phone layout and a large project with hundreds of areas.
10. Restart the app after a saved note/photo, after a sync, and while offline. Verify the work and project list still load; if a recovery screen appears, copy its reference and error details.

Do not treat passing local unit tests or a single browser as a four-person pass. Record the outcome of each step before using this branch with the larger team.
