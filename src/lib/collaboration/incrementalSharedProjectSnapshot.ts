import type { Project } from '@/types';
import { getPendingSharedAreaSyncsForProject, getPendingSharedProjectMetadataSyncForProject } from '@/lib/db';
import { getCollaborationSupabaseClient } from './supabaseClient';
import { applySharedProjectMetadataSnapshot, getSharedProjectMetadataSnapshot } from './sharedProjectMetadata';
import { parseSharedProjectAreaSnapshots, type SharedProjectAreaSnapshotRow } from './sharedProjectAreas';

type AreaRevision = Pick<SharedProjectAreaSnapshotRow, 'area_id' | 'version' | 'published_at'>;
const PAGE_SIZE = 500;
const AREA_BATCH_SIZE = 50;

export async function listSharedProjectAreaRevisions(sharedProjectId: string, baseline: string) {
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) throw new Error('Collaboration is not configured.');
  const revisions: AreaRevision[] = [];
  // Identity order stays stable when an existing area is republished between pages.
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const result = await supabase.from('shared_project_area_snapshots')
      .select('area_id, version, published_at').eq('project_id', sharedProjectId)
      .gt('published_at', baseline).order('area_id', { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (result.error) {
      if (['42P01', 'PGRST205'].includes(result.error.code)) return null;
      throw result.error;
    }
    revisions.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < PAGE_SIZE) return revisions;
  }
}

/** Reuse only an accepted, clean local baseline. Dirty copies need the full merge path. */
export async function getIncrementalSharedProjectSnapshot(local: Project): Promise<{
  project: Project; publishedAt: string;
} | null> {
  const localBaseline = local.sharedBaselinePublishedAt?.toISOString();
  const acceptedAt = local.sharedSnapshotPublishedAt?.getTime();
  if (!local.sharedProjectId || local.deletedAt || !localBaseline || !acceptedAt || local.updatedAt.getTime() > acceptedAt) return null;
  if (local.areas.some((area) => Math.max(area.updatedAt.getTime(), area.deletedAt?.getTime() ?? 0,
    area.purgedAt?.getTime() ?? 0) > (area.sharedPublishedAt?.getTime() ?? new Date(localBaseline).getTime()))) return null;
  const [pendingAreas, pendingMetadata] = await Promise.all([
    getPendingSharedAreaSyncsForProject(local.id), getPendingSharedProjectMetadataSyncForProject(local.id),
  ]);
  if (pendingAreas.length || pendingMetadata) return null;
  const supabase = getCollaborationSupabaseClient();
  if (!supabase) throw new Error('Collaboration is not configured.');
  const readBaseline = async () => {
    const result = await supabase.from('shared_project_snapshots').select('published_at')
      .eq('project_id', local.sharedProjectId!).maybeSingle();
    if (result.error) throw result.error;
    return result.data?.published_at;
  };
  const baseline = await readBaseline();
  if (!baseline || new Date(baseline).getTime() !== new Date(localBaseline).getTime()) return null;

  const [revisions, metadata] = await Promise.all([
    listSharedProjectAreaRevisions(local.sharedProjectId, baseline),
    getSharedProjectMetadataSnapshot(local.sharedProjectId),
  ]);
  if (!revisions) return null;
  const localAreas = new Map(local.areas.map((area) => [area.id, area]));
  const remoteIds = new Set(revisions.map((row) => row.area_id));
  // A removed overlay can indicate a concurrent baseline replacement. Never
  // certify local-only data as the server copy in that situation.
  if (local.areas.some((area) => area.sharedPublishedAt && area.sharedPublishedAt > new Date(baseline)
    && !remoteIds.has(area.id))) return null;
  const changed = revisions.filter((row) => {
    const area = localAreas.get(row.area_id);
    return !area || area.sharedVersion !== row.version || area.sharedPublishedAt?.getTime() !== new Date(row.published_at).getTime();
  });
  if (revisions.some((row) => (localAreas.get(row.area_id)?.sharedVersion ?? 0) > row.version)) return null;

  const rows: SharedProjectAreaSnapshotRow[] = [];
  for (let offset = 0; offset < changed.length; offset += AREA_BATCH_SIZE) {
    const batch = changed.slice(offset, offset + AREA_BATCH_SIZE);
    const result = await supabase.from('shared_project_area_snapshots')
      .select('project_id, area_id, area_payload, payload_version, version, published_by_user_id, published_at')
      .eq('project_id', local.sharedProjectId).in('area_id', batch.map((row) => row.area_id));
    if (result.error) throw result.error;
    const received = new Map((result.data ?? []).map((row) => [row.area_id, row]));
    if (batch.some((revision) => {
      const row = received.get(revision.area_id);
      return !row || row.version < revision.version || new Date(row.published_at) <= new Date(baseline);
    })) return null;
    rows.push(...(result.data ?? []));
  }

  // Changed media still uses the existing content-hash verification and cache.
  // Metadata rules may materialize checkpoints in accepted areas. Copy the
  // hierarchy without copying immutable media strings or mutating the source
  // used by the caller's conflict and concurrent-save checks.
  const areas = new Map(local.areas.map((area) => [area.id, { ...area,
    locations: area.locations.map((location) => ({ ...location,
      items: location.items.map((item) => ({ ...item,
        checkpoints: item.checkpoints.map((checkpoint) => ({ ...checkpoint,
          photos: checkpoint.photos.map((photo) => ({ ...photo })),
          files: (checkpoint.files ?? []).map((file) => ({ ...file })),
        })),
      })),
    })),
  }]));
  const drawings = new Map((local.facadeElevationDrawings ?? []).map((drawing) => [drawing.id, drawing]));
  const parsedAreas = await parseSharedProjectAreaSnapshots(rows, local.id, local.sharedProjectId, local);
  for (const parsed of parsedAreas) {
    areas.set(parsed.area.id, parsed.area);
    parsed.drawings.forEach((drawing) => {
      const current = drawings.get(drawing.id);
      if (!current || drawing.updatedAt >= current.updatedAt) drawings.set(drawing.id, drawing);
    });
  }
  // A full publish can clear overlays while these reads are running. Restart
  // through the full path instead of applying a mixture of two baselines.
  if (await readBaseline() !== baseline) return null;
  let publishedAt = baseline;
  for (const row of [...revisions, ...rows, ...(metadata ? [metadata] : [])]) {
    if (new Date(row.published_at) > new Date(publishedAt)) publishedAt = row.published_at;
  }
  let project: Project = { ...local, areas: [...areas.values()],
    facadeElevationDrawings: drawings.size ? [...drawings.values()] : undefined,
    sharedSnapshotPublishedAt: new Date(publishedAt) };
  if (metadata) project = applySharedProjectMetadataSnapshot(project, metadata);
  return { project, publishedAt };
}
