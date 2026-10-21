# sync

Team changes are sent to the team server. Signed-in browsers refresh clean Team
copies on list pages after realtime notices (coalesced for 250 ms), on
focus/reconnection, and every 30 seconds while visible as a fallback.
Clean copies with the same server baseline compare area versions and download
only changed area payloads and missing media. Pending work, legacy copies, or a
changed baseline retain the full guarded pull/review path. Revision lists and
full downloads are paginated for large projects.
Areas check for clean updates before enabling editing. Changes from the same
account in another browser are included. Locks belong to the account; device IDs
identify the originating browser for automatic lock cleanup and backups. Explicit
area release works across devices after checking the accepted area version.

Personal and Team changes queued on a signed-in browser are automatically backed
up to the account's OneDrive. `Sync This Team Project` confirms the accepted team
changes immediately and queues its separate OneDrive backup. Background OneDrive
work does not block team refreshes; failed backups remain pending and can be
retried through `OneDrive Sync / Backup`. Clean personal copies merge updates on list pages, and
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
