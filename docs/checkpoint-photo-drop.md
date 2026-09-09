# Photo drop and shared checkpoint rules

Desktop users can drop multiple image files onto an item or checkpoint, or choose Add photos. A checkpoint accepts a batch directly. An item offers its checkpoints plus New checkpoint. Images are resized sequentially using the existing photo conversion code and saved through capture recovery. Undo removes only the saved photo IDs from the last batch using a checkpoint-level transaction.

New checkpoint creation offers an unchecked option to add the checkpoint to the same room and item in all existing and future apartment units. This option is also available in the existing Add checkpoint composer. Matching ignores case and repeated whitespace. Existing checkpoint results and photos are preserved. Photos attach only to the original destination. Rules are additive; this change does not provide a project-rule removal editor.

Rules are project metadata, validated on import and shared metadata intake, included in backups, and applied when loading projects or creating units. Deterministic checkpoint IDs prevent teammates from independently creating different IDs for the same rule. Applying a rule does not queue edits to another inspector's claimed area. Normal area edits still require that area's claim; metadata uses the existing team edit permission and version/conflict checks. Offline rules queue for sync. Rules are merged during team conflict resolution.

## Rollout

Apply `supabase/migrations/20260909190000_project_checkpoint_rules.sql` before rolling out the web app. The RPC retains existing authentication, edit permission, idempotency, and version checks, and accepts the optional checkpointRules field. Older metadata writes that omit rules preserve the server's rules. All teammates need the updated app to read the extended metadata payload and see the new checkpoints. The migration has not been applied to production by this task.

## Verification

- Automated rule tests cover matching, deduplication, deterministic teammate IDs, future units, shared metadata queuing, backup round-trips, merge behavior, and batch undo preserving later photos/notes.
- Existing capture recovery, metadata, and application tests passed.
- An isolated browser harness exercised the real drop-event handler with two generated image files, checkpoint selection, batch undo, and creating a new checkpoint with the all-units checkbox. It used in-memory save callbacks; no real inspection data was changed. Finder-to-browser dragging and live two-account synchronization remain rollout checks.
- The SQL migration was executed in local PGlite with stubbed authentication and team tables, checking valid publish, idempotency, stale-version rejection, invalid-rule rejection, older-client preservation, and edit permission denial. This does not replace a live Supabase/team check.
