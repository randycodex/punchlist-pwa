# Punchlist PWA seamless automation handoff

Date: 2026-07-08

This file is for continuing the current "make users do less" work from another computer or another Codex thread.

## Current repo state

- Working directory: `/Users/randy/Documents/X_CODING/punchlist-pwa`
- Branch: `main`
- Latest pushed app-code commit at the time this handoff was written: `9c4e7a72 Guard live shared refresh on area pages`
- The app is a Next.js PWA with local IndexedDB persistence, Microsoft/OneDrive sync, and Supabase-backed shared-project collaboration.
- Do not store Supabase passwords, database passwords, or user credentials in this file.

## User direction

- Main goal: users should do as little as possible while using the app.
- Collaboration should feel instant once a user opens an area.
- Automate safe background work, but do not automate destructive choices or data-policy decisions.
- Keep export methods as-is. Do not continue the local-vs-OneDrive export decision.
- Always tell the user what is next.
- Commit completed work by default after checking `git status` and diff scope.
- Push only when the user asks to push.

## Current seamless-automation list

1. Area locking should feel immediate when a shared area opens.
   - Baseline is implemented: area pages claim the shared area, renew the claim, release on page hide, and show claim errors.
   - Strengthening still possible: clearer occupied/blocked UI, faster visible claim feedback, and stronger handling if the claim is lost while editing.

2. Resume stale shared publishes in the background.
   - Done in earlier work.
   - Relevant recent commit: `0905c1a2 Resume stale shared publishes on load`.

3. Keep sync visible on area pages.
   - Done in earlier work.
   - Relevant recent commits: `b3e847c1 Enable top bar sync on area pages`, `50410449 Keep area page sync visible`.

4. Automate safe shared pulls.
   - Done.
   - Manual "Pull shared data" now no-ops if current, applies immediately when the shared snapshot is newer and local data is not newer, and keeps the confirmation/backup path only when local edits are newer.
   - Relevant recent commit: `84a7aead Automate safe shared pulls`.

5. Live-refresh safe shared snapshots on project pages.
   - Done.
   - Home/project detail pages subscribe to `shared_project_snapshots` and safely apply newer shared snapshots when local edits are not newer.
   - Relevant recent commit: `3da58c83 Live refresh safe shared snapshots`.

6. Guard live shared refresh on area pages.
   - Done.
   - Area pages now subscribe to shared snapshot changes, apply safe remote updates automatically, and avoid replacing the page while the user is drafting or editing.
   - Relevant recent commit: `9c4e7a72 Guard live shared refresh on area pages`.

7. Export method decision.
   - Removed from plan by user.
   - Leave export behavior as-is.

8. Export behavior.
   - No current action. User said this is fine as-is.

9. Make blocked shared updates actionable.
   - Next work item.
   - Current behavior: area pages detect blocked live shared updates, but they surface through a generic `syncError` strip.
   - Desired behavior: show a persistent, clear shared-update banner.
   - If the user is typing/editing: banner should say the shared update is ready and will apply automatically after the edit is finished.
   - If local edits are newer: banner should offer a safe review path back to the project page instead of silently asking the user to interpret the state.
   - Do not add a destructive "pull anyway" button on the area page.

10. Dashboard live shared refresh for multiple projects.
   - Work after point 9.
   - Goal: make the dashboard feel current without requiring manual refresh.
   - Important constraint: do not pull full whole-project snapshots for every dashboard event if metadata/timestamp checks can avoid it. Whole-project JSON snapshots are still a scaling risk.

## Recommended next implementation

Start with point 9: make blocked shared updates actionable.

Likely file:

- `src/app/project/[id]/area/[areaId]/page.tsx`

Suggested approach:

- Add dedicated state instead of using generic `syncError` for live shared updates, for example:

```ts
type LiveSharedUpdateState =
  | { kind: 'waiting-for-draft'; message: string }
  | { kind: 'local-newer'; message: string }
  | null;
```

- In the live shared snapshot effect:
  - When blocked by drafts/editing, set `waiting-for-draft` and keep `pendingLiveSharedRefreshRef.current = true`.
  - When local edits are newer, set `local-newer`.
  - When a safe apply succeeds, clear this state.
- Render a small persistent banner near the current sync strip.
- For `waiting-for-draft`, no button is required; it should auto-apply when the draft/edit closes.
- For `local-newer`, include a safe "Review" action that routes to `/project/${project.id}` so the existing pull/backup flow can handle it.

## Validation commands

Run these before committing a code slice:

```bash
npx eslint 'src/app/project/[id]/area/[areaId]/page.tsx'
npx tsc --noEmit
npm run build
```

If checking the live app locally:

```bash
npm run dev
```

Then open:

- `http://localhost:3000/`
- a project page
- an area page

## Continuation prompt for another computer

Use this prompt in a new Codex thread after pulling the repo:

```text
We are continuing the punchlist-pwa seamless automation work from SEAMLESS_AUTOMATION_HANDOFF.md.
The next item is point 9: make blocked shared updates actionable on the area page.
Please inspect the current repo, implement the dedicated live shared update banner in src/app/project/[id]/area/[areaId]/page.tsx, validate with eslint/tsc/build, commit the completed slice, and tell me what is next.
Do not change export methods.
Do not add destructive pull-anyway behavior on the area page.
```

