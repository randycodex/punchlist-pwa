'use client';

import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import type { Project } from '@/types';
import { positionKey } from '@/features/inspection/inspectionPosition';
import { readLocalStorage } from '@/lib/browserStorage';

function subscribe(callback: () => void) {
  window.addEventListener('storage', callback);
  window.addEventListener('punchlist-inspection-position', callback);
  return () => { window.removeEventListener('storage', callback); window.removeEventListener('punchlist-inspection-position', callback); };
}

export default function ResumeInspectionLink({ project }: { project: Project }) {
  const raw = useSyncExternalStore(subscribe, () => readLocalStorage(positionKey(project.id)), () => null);
  let areaId: string | undefined;
  try { areaId = JSON.parse(raw ?? 'null')?.areaId; } catch { /* Ignore invalid local navigation state. */ }
  const area = project.areas.find((entry) => entry.id === areaId && !entry.deletedAt);
  if (!area) return null;
  return <Link className="mx-auto mb-4 flex min-h-12 w-full max-w-6xl items-center justify-between gap-3 rounded-2xl accent-bg px-4 py-3 text-sm font-semibold text-white" href={`/project/${project.id}/area/${area.id}`}>
    <span>Resume inspection</span><span className="truncate font-normal">{area.name} →</span>
  </Link>;
}
