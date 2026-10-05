# sync

Team changes are sent to the team server. `Get Team Updates` separately downloads
the latest shared changes and photos onto this device; pending updates do not
prevent a backup of the device's current copy.

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
