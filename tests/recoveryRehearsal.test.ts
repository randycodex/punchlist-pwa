import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaborationTestDatabase } from './helpers/collaborationDatabase';
import { createProject, createArea, createLocation, createItem, createCheckpoint, createPhotoAttachment } from '@/lib/db';
import { createCompactSharedSnapshotPayload, parseSharedSnapshotPayload } from '@/lib/collaboration/sharedSnapshotPayload';
import { hydrateSharedSnapshotAssetsWithResolver } from '@/lib/collaboration/sharedSnapshotAssets';
import { objectDigest, verifyRecoveryObjects, type RecoveryObject } from './helpers/recoveryStorage';

const owner = '00000000-0000-4000-8000-000000000701';
const attachment = '00000000-0000-4000-8000-000000000702';
// Actual decodable 1x1 PNG; synthetic, contains no production photograph.
const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV0sAAAAASUVORK5CYII=', 'base64');
const tables = ['auth.users', 'public.shared_projects', 'public.project_members', 'public.shared_project_snapshots', 'public.shared_project_snapshot_history', 'public.shared_attachments', 'storage.buckets', 'storage.objects'];
let root: string;
let source: PGlite;
let restored: PGlite;
let expected: unknown[];
let manifest: RecoveryObject[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'punchlist-synthetic-recovery-'));
  source = await createCollaborationTestDatabase();
  await source.query('insert into auth.users(id,email) values ($1,$2)', [owner, 'synthetic-recovery@uai-ny.com']);
  await source.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.email','synthetic-recovery@uai-ny.com',false)", [owner]);
  const project = (await source.query<{ id: string }>('select public.create_shared_project($1,$2,$3) as id', [crypto.randomUUID(), 'Synthetic recovery', 'synthetic-recovery@uai-ny.com'])).rows[0].id;
  const bucket = 'punchlist-attachments';
  const path = `${project}/${attachment}/synthetic.png`;
  const local = createProject('Synthetic recovery');
  local.sharedProjectId = project;
  const area = createArea(local.id, 'Synthetic area', 0);
  const location = createLocation(area.id, 'Synthetic location', 0);
  const item = createItem(location.id, 'Synthetic item', 0);
  const checkpoint = createCheckpoint(item.id, 'Synthetic checkpoint', 0);
  const attachedPhoto = createPhotoAttachment(checkpoint.id, `data:image/png;base64,${photo.toString('base64')}`);
  attachedPhoto.id = attachment;
  checkpoint.photos.push(attachedPhoto);
  item.checkpoints.push(checkpoint);
  location.items.push(item);
  area.locations.push(location);
  local.areas.push(area);
  const payload = createCompactSharedSnapshotPayload(local, {
    photos: { [attachment]: { image: { bucket, path, mimeType: 'image/png', sizeBytes: photo.length, sha256: objectDigest(photo) } } },
    files: {}, drawings: {},
  });
  await source.query('insert into public.shared_project_snapshots(project_id,project_payload,payload_version,published_by_user_id) values ($1,$2,2,$3)', [project, payload, owner]);
  await source.query('select public.capture_shared_project_device_backup($1,$2,$3,2,$4,$5)', [project, crypto.randomUUID(), payload, 'manual', 'Synthetic recovery rehearsal']);
  await source.query('insert into public.shared_attachments(id,project_id,uploaded_by_user_id,storage_bucket,storage_path,file_name,mime_type,size_bytes) values ($1,$2,$3,$4,$5,$6,$7,$8)', [attachment, project, owner, bucket, path, 'synthetic.png', 'image/png', photo.length]);
  await source.query('insert into storage.objects(bucket_id,name) values ($1,$2)', [bucket, path]);
  manifest = [{ bucket, path, size: photo.length, sha256: objectDigest(photo) }];
  await mkdir(join(root, 'source-objects', bucket, project, attachment), { recursive: true });
  await writeFile(join(root, 'source-objects', bucket, path), photo);
  expected = await Promise.all(tables.map(async (table) => (await source.query(`select * from ${table} order by 1`)).rows));
  // Embedded PostgreSQL archive, not a production pg_dump or Supabase backup.
  const dump = await source.dumpDataDir();
  await writeFile(join(root, 'synthetic-postgres.tar'), Buffer.from(await dump.arrayBuffer()));
  await writeFile(join(root, 'objects-manifest.json'), JSON.stringify(manifest));
  await source.close();
  restored = new PGlite({ loadDataDir: new Blob([await readFile(join(root, 'synthetic-postgres.tar'))]), extensions: { pgcrypto } });
  await cp(join(root, 'source-objects'), join(root, 'restored-objects'), { recursive: true });
}, 30000);
afterAll(async () => { await restored?.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe('disposable synthetic database and photo recovery', () => {
  it('restores snapshots, immutable recovery IDs, metadata, users, membership and bucket configuration exactly', async () => {
    const actual = await Promise.all(tables.map(async (table) => (await restored.query(`select * from ${table} order by 1`)).rows));
    expect(actual).toEqual(expected);
    expect(await verifyRecoveryObjects(join(root, 'restored-objects'), manifest)).toBe(1);
    expect(await readFile(join(root, 'restored-objects', manifest[0].bucket, manifest[0].path))).toEqual(photo);
    for (const table of ['public.shared_project_snapshots', 'public.shared_project_snapshot_history']) {
      const row = (await restored.query<{ project_id: string; project_payload: unknown; payload_version: number }>(`select project_id, project_payload, payload_version from ${table}`)).rows[0];
      const parsed = parseSharedSnapshotPayload(row.project_payload, row.payload_version);
      expect(parsed.project.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe('');
      const hydrated = await hydrateSharedSnapshotAssetsWithResolver(parsed.project, parsed.assets, row.project_id, async (reference) => {
        const bytes = await readFile(join(root, 'restored-objects', reference.bucket, reference.path));
        expect(bytes.length).toBe(reference.sizeBytes);
        expect(objectDigest(bytes)).toBe(reference.sha256);
        return `data:${reference.mimeType};base64,${bytes.toString('base64')}`;
      });
      expect(hydrated.areas[0].locations[0].items[0].checkpoints[0].photos[0].imageData).toBe(`data:image/png;base64,${photo.toString('base64')}`);
    }
  });
  it('fails recovery verification when object bytes are absent or corrupted, despite healthy database metadata', async () => {
    await expect(verifyRecoveryObjects(join(root, 'missing-objects'), manifest)).rejects.toMatchObject({ code: 'ENOENT' });
    const corruptRoot = join(root, 'corrupt-objects');
    await cp(join(root, 'source-objects'), corruptRoot, { recursive: true });
    const corrupt = Buffer.from(photo); corrupt[corrupt.length - 1] ^= 1;
    await writeFile(join(corruptRoot, manifest[0].bucket, manifest[0].path), corrupt);
    await expect(verifyRecoveryObjects(corruptRoot, manifest)).rejects.toThrow('integrity mismatch');
  });
  it('rejects unsafe or duplicate manifest paths', async () => {
    await expect(verifyRecoveryObjects(root, [{ ...manifest[0], path: '../escape' }])).rejects.toThrow('Invalid recovery object key');
    await expect(verifyRecoveryObjects(join(root, 'restored-objects'), [...manifest, ...manifest])).rejects.toThrow('Invalid recovery object key');
  });
});
