# Active Threads

Use one branch + one worktree per workstream.

## Naming Rules

- Branches must start with `codex/`
- Branch format: `codex/<scope>-<topic>`
- Examples:
  - `codex/pdf-layout`
  - `codex/sync-conflicts`
  - `codex/ui-header`

## Quick Start

1. Create a thread worktree:
   - `npm run thread:new -- <thread-name>`
2. Work only inside that worktree.
3. Open a PR scoped to one concern.
4. Keep this file updated.

## Thread Board

| Thread | Branch | Worktree Path | Scope | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| Transfer failure isolation | `codex/sync-transfer-failure-isolation` | `/workspace/punchlist-worktrees/sync-transfer-failure-isolation` | Keep concurrent upload/download failures local to their operation | Ready | Codex | PR #5 finding reproduced and fixed; 38 relevant tests, TypeScript, lint passed. Synthetic data only; local changes. |
| Incremental team sync | `codex/sync-incremental-updates` | `/workspace/punchlist-worktrees/sync-incremental-updates` | Changed-area pulls, realtime refresh, background OneDrive backups | Ready | Codex | `npm run verify` passed: 686 tests, lint, TypeScript, production build. Local candidate; not deployed. |
| Main integration | `main` | `.` | Stable baseline + merges | Active | You | Do release checks here |
| UI / Layout | `codex/ui-layout` | `.worktrees/ui-layout` | Shared layout, navigation, menus, visual polish | Planned | You | |
| Camera / Photos / Files | `codex/camera-photos-files` | `.worktrees/camera-photos-files` | Camera capture, attachments, previews, file handling | Planned | You | |
| Performance / Stability | `codex/performance-stability` | `.worktrees/performance-stability` | Runtime errors, responsiveness, dependency/runtime fixes | Planned | You | |
| Release / Deploy | `codex/release-deploy` | `.worktrees/release-deploy` | Build, environment setup, deploy readiness, release checks | Planned | You | |
| Inspection Flow | `codex/inspection-flow` | `.worktrees/inspection-flow` | Project, area, and inspection walkthrough UX | Planned | You | |
| PDF Export | `codex/pdf-export` | `.worktrees/pdf-export` | PDF generation, layout, export behavior | Planned | You | |
| Sync / OneDrive | `codex/sync-onedrive` | `.worktrees/sync-onedrive` | OneDrive auth, sync behavior, conflict handling | Planned | You | |
| Collaboration Mode | `collaboration-mode` | `.` | Shared project architecture, membership, realtime sync | Active | You | User-requested branch name |
