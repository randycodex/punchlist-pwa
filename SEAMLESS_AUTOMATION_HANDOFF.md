# Punchlist PWA seamless automation handoff

Date: 2026-07-15

This file is for continuing the current "make users do less" work from another computer or another Codex thread.

## Current repo state

- Working directory: `/Users/randy/Documents/X_CODING/punchlist-pwa`
- Branch: `main`
- Use `git log --oneline` for the current branch tip; the automation items recorded below are all implemented.
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
   - Done.
   - Area pages show a persistent team-update banner and route users back to the project page for the existing safe review/backup flow.
   - The area page does not expose a destructive "pull anyway" action.
   - Relevant commit: `c96e4deb Make blocked shared updates actionable`.

10. Dashboard live shared refresh for multiple projects.
   - Done.
   - Multi-project dashboards subscribe to shared snapshot changes and mark only the affected local project as having an update.
   - The dashboard avoids automatically pulling every full project snapshot for each event.
   - Relevant commit: `fcdbcf69 Live refresh shared dashboard projects`.

## Plan completion status

All ten items in this seamless-automation handoff are complete or intentionally removed from scope. There is no remaining implementation slice in this file.

Broader future collaboration phases—entity-level mutation processing, audit/conflict UI, member administration, and recovery tooling—remain product roadmap work in `src/features/collaboration/README.md`. Start those only as an explicitly scoped new phase; do not treat them as unfinished work from this automation handoff.

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
The seamless-automation list in SEAMLESS_AUTOMATION_HANDOFF.md is complete.
Please inspect the current repo and git state before starting anything new. If the user requests more collaboration work, scope it against src/features/collaboration/README.md as a new roadmap phase, preserve the existing safe pull and area-lock behavior, validate the full affected flow, commit the completed slice, and say what is next.
```
