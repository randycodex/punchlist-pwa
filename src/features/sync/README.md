# sync

Team changes are sent to the team server. Signed-in browsers refresh clean Team
copies on list pages, on focus/reconnection, and every 30 seconds while visible.
Areas check for clean updates before enabling editing. Changes from the same
account in another browser are included. Locks belong to the account; device IDs
identify the originating browser for automatic lock cleanup and backups. Explicit
area release works across devices after checking the accepted area version.

Personal changes queued on a signed-in browser are automatically backed up to
the account's OneDrive. Clean personal copies merge updates on list pages, and
missing personal backups are downloaded. Automatic refresh does not perform
permanent-deletion cleanup, reconnect detached Team copies, force a newer-copy
overwrite, or replace retained captures or pending Team edits. Editors keep
their working copy. Conflicts still use `Sync This Project` / `Get Team Updates`
for review. Work saved offline appears elsewhere after its source browser sends
it; sign in with the same Microsoft account in each browser.

Team Project OneDrive backups live under
`PunchList/Team Backups/<team ID>/<device ID>/<project name and local ID>/`.
Each JSON includes `oneDriveBackup.photosPath`, pointing to its device's sibling
`photos/` folder. Photos are uploaded before JSON. JSON filenames include a
content digest and use Microsoft Graph's `conflictBehavior=fail`, so other
devices and older snapshots are preserved. An identical completed snapshot is
reused; uncertain responses are reconciled before at most three create attempts.

The Team Backups container is excluded from personal restore and merge. Legacy
Team Project backups remain untouched. Personal backups retain newer-copy and
conditional-write protection. Removing a local Team Project does not delete its
OneDrive snapshots. History is retained; no automatic snapshot cleanup is applied.
