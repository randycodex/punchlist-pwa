const launchedOneDriveSyncAccounts = new Set<string>();

export function reserveLaunchOneDriveSync(accountKey: string) {
  if (launchedOneDriveSyncAccounts.has(accountKey)) {
    return false;
  }
  launchedOneDriveSyncAccounts.add(accountKey);
  return true;
}

export function resetLaunchOneDriveSyncReservations() {
  launchedOneDriveSyncAccounts.clear();
}
