# Unit floor grouping

The grouped area view divides Units into floor sections in numeric order, keeping the user's existing sort within each floor. The All view remains a flat list. Unknown numbers stay visible under Floor not set.

Edit Project → Unit floor numbering selects the project convention:
- Default: digits before letters, including 14A and 14-A → Floor 14.
- Numeric: the final two digits identify the unit, so 1401 → Floor 14 and 301 → Floor 3.
- Manual: no automatic inference.

Edit a unit → Floor override sets exceptions such as Ground or Penthouse. Blank restores inference. A floor-only edit does not reset the inspection checklist. Bulk imports start with automatic inference rather than copying a hidden single-unit override.

The setting is included in project metadata and backups; overrides are included in area data. Team rollout requires applying `supabase/migrations/20260909193000_unit_floor_numbering.sql` and refreshing teammates to the updated app. The migration preserves checkpoint-rule support and existing permission/version checks, and older clients that omit the floor setting do not erase it. No production database changes were performed in this task.

Verification includes the supplied 175-unit schedule (all 14 floors recognized), inference/override/order/backup/shared-metadata tests, an isolated rendered grouping/settings check, and local PGlite execution of the metadata RPC with validation, conflict, old-client preservation, and permission-denial cases. Live multi-account synchronization remains a rollout check.
