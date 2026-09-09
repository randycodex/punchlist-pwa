const key = (projectId: string) => `punchlist-area-return:${projectId}`;

export function rememberAreaReturnTarget(projectId: string, areaId: string) {
  try { sessionStorage.setItem(key(projectId), areaId); } catch { /* Storage can be unavailable in private contexts. */ }
}

export function readAreaReturnTarget(projectId: string): string | null {
  try { return sessionStorage.getItem(key(projectId)); } catch { return null; }
}

export function clearAreaReturnTarget(projectId: string, areaId: string) {
  try {
    if (sessionStorage.getItem(key(projectId)) === areaId) sessionStorage.removeItem(key(projectId));
  } catch { /* Scrolling must never block navigation. */ }
}
