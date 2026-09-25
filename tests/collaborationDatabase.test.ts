import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createCollaborationTestDatabase } from './helpers/collaborationDatabase';

const owner = '00000000-0000-4000-8000-000000000001';
const member = '00000000-0000-4000-8000-000000000002';
const phone = '00000000-0000-4000-8000-000000000003';
const computer = '00000000-0000-4000-8000-000000000004';
const localProject = '00000000-0000-4000-8000-000000000005';
const area = '00000000-0000-4000-8000-000000000006';
let db: PGlite;
let project: string;
let claim: string;
async function signIn(id: string, email: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.email', $2, false)", [id, email]);
  await db.exec('set role authenticated');
}

beforeAll(async () => {
  db = await createCollaborationTestDatabase();
  await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [owner, 'owner@uai-ny.com', member, 'member@uai-ny.com']);
  await signIn(owner, 'owner@uai-ny.com');
  project = (await db.query<{ id: string }>('select public.create_shared_project($1,$2,$3) as id', [localProject, 'Database test', 'owner@uai-ny.com'])).rows[0].id;
  await db.query('select public.publish_shared_project_snapshot_v2($1,$2,1,null,0)', [project, { id: localProject, projectName: 'Database test', areas: [{ id: area, locations: [] }] }]);
  const code = (await db.query<{ result: { join_code: string } }>('select public.generate_shared_project_join_code($1) as result', [project])).rows[0].result.join_code;
  await signIn(member, 'member@uai-ny.com');
  await db.query('select public.join_shared_project_by_code($1,$2)', [code, 'member@uai-ny.com']);
}, 30000);
afterAll(async () => { await db?.close(); });

describe('database enforcement under authenticated member privileges', () => {
  it('keeps member reads but denies direct ownership, membership, claim, and snapshot mutation', async () => {
    expect((await db.query('select id from public.shared_projects')).rows).toHaveLength(1);
    for (const table of ['shared_projects', 'project_members', 'area_claims', 'collaboration_mutations', 'shared_project_snapshots']) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege('authenticated', $1, 'UPDATE') as allowed", [`public.${table}`])).rows[0].allowed).toBe(false);
    }
    await expect(db.query('update public.shared_projects set owner_user_id=$1 where id=$2', [member, project])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('select public.remove_shared_project_member($1,$2)', [project, 'owner@uai-ny.com'])).rejects.toMatchObject({ code: '42501' });
  });

  it('claims idempotently on one device and blocks the same account on another', async () => {
    claim = (await db.query<{ result: { id: string } }>('select public.claim_shared_project_area_v2($1,$2,$3) as result', [project, area, phone])).rows[0].result.id;
    expect((await db.query<{ result: { id: string } }>('select public.claim_shared_project_area_v2($1,$2,$3) as result', [project, area, phone])).rows[0].result.id).toBe(claim);
    await expect(db.query('select public.claim_shared_project_area_v2($1,$2,$3)', [project, area, computer])).rejects.toMatchObject({ code: '55P03' });
    await expect(db.query('select public.release_shared_project_area_v2($1,$2,$3,$4,0)', [project, area, claim, computer])).rejects.toMatchObject({ code: '55P03' });
    await expect(db.query('select public.release_shared_project_area($1,$2)', [project, area])).rejects.toMatchObject({ code: '42501' });
  });

  it('checks the accepted version, rejects stale claim IDs, and retries release safely', async () => {
    await expect(db.query('select public.release_shared_project_area_v2($1,$2,$3,$4,3)', [project, area, claim, phone])).rejects.toMatchObject({ code: 'PT409' });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await db.query<{ ok: boolean }>('select public.release_shared_project_area_v2($1,$2,$3,$4,0) as ok', [project, area, claim, phone])).rows[0].ok).toBe(true);
    }
    const replacement = (await db.query<{ result: { id: string } }>('select public.claim_shared_project_area_v2($1,$2,$3) as result', [project, area, computer])).rows[0].result.id;
    await db.query('select public.release_shared_project_area_v2($1,$2,$3,$4,0)', [project, area, claim, phone]);
    expect((await db.query('select id from public.area_claims where id=$1 and status=$2', [replacement, 'active'])).rows).toHaveLength(1);
  });
});

it('publishes through the guarded RPC, retries idempotently, and rejects stale edits', async () => {
  const id = crypto.randomUUID();
  const payload = { id: localProject, projectName: 'Database test', areas: [{ id, locations: [] }] };
  const sql = 'select * from public.publish_shared_project_area_snapshot($1,$2,$3,1,$4,null,$5,$6)';
  const first = (await db.query(sql, [project, id, payload, 0, 'accepted-retry-key', computer])).rows;
  expect((await db.query(sql, [project, id, payload, 0, 'accepted-retry-key', computer])).rows).toEqual(first);
  await expect(db.query(sql, [project, id, payload, 0, 'different-stale-key', computer])).rejects.toMatchObject({ code: 'PT409' });
  await expect(db.query(sql, [project, id, payload, 1, 'wrong-device-key', phone])).rejects.toMatchObject({ code: '55P03' });
  await expect(db.query('select * from public.publish_shared_project_area_snapshot_internal($1,$2,$3,1,1,null,$4)', [project, id, payload, 'bypass'])).rejects.toMatchObject({ code: '42501' });
});

it('prevents replacement of existing storage objects used by backups', async () => {
  const path = `${project}/photo/example.jpg`;
  await db.query('insert into storage.objects(bucket_id,name) values ($1,$2)', ['punchlist-attachments', path]);
  expect((await db.query('update storage.objects set name=$1 where name=$2 returning id', ['changed', path])).rows).toHaveLength(0);
  expect((await db.query('delete from storage.objects where name=$1 returning id', [path])).rows).toHaveLength(0);
  expect((await db.query('select id from storage.objects where name=$1', [path])).rows).toHaveLength(1);
});

it('restricts cleanup reports to owners and preserves historical attachment references', async () => {
  await expect(db.query('select * from public.list_unreferenced_shared_attachments($1)', [project])).rejects.toMatchObject({ code: '42501' });
  await db.exec('reset role');
  const retained = `${project}/photo/retained.jpg`;
  const orphan = `${project}/photo/orphan.jpg`;
  for (const path of [retained, orphan]) {
    await db.query(`insert into public.shared_attachments(project_id,uploaded_by_user_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,updated_at)
      values ($1,$2,'punchlist-attachments',$3,'photo.jpg','image/jpeg',100,now()-interval '8 days')`, [project, owner, path]);
  }
  await db.query(`insert into public.shared_project_snapshot_history(project_id,project_payload,payload_version,captured_by_user_id)
    values ($1,$2,2,$3)`, [project, { assets: { photos: { photo: { image: { path: retained } } } } }, owner]);
  await signIn(owner, 'owner@uai-ny.com');
  expect((await db.query<{ storage_path: string }>('select * from public.list_unreferenced_shared_attachments($1)', [project])).rows.map(row => row.storage_path)).toEqual([orphan]);
});

it('lets the owner explicitly recover a lost device while rejecting full replacement under a claim', async () => {
  const id = crypto.randomUUID();
  const ownClaim = (await db.query<{ result: { id: string } }>('select public.claim_shared_project_area_v2($1,$2,$3) as result', [project, id, phone])).rows[0].result.id;
  await expect(db.query('select public.publish_shared_project_snapshot_v2($1,$2,1,null,1)', [project, { id: localProject, areas: [] }])).rejects.toMatchObject({ code: '55P03' });
  expect((await db.query<{ ok: boolean }>('select public.release_abandoned_shared_project_area($1,$2,$3) as ok', [project, id, ownClaim])).rows[0].ok).toBe(true);
});

it('denies an unrelated signed-in user access to projects, photos, and guarded writes', async () => {
  const outsider = crypto.randomUUID();
  await db.exec('reset role');
  await db.query('insert into auth.users(id,email) values ($1,$2)', [outsider, 'outsider@uai-ny.com']);
  await signIn(outsider, 'outsider@uai-ny.com');
  for (const table of ['shared_projects', 'project_members', 'area_claims', 'shared_project_snapshots', 'shared_attachments']) {
    expect((await db.query(`select * from public.${table}`)).rows).toHaveLength(0);
  }
  expect((await db.query("select * from storage.objects where bucket_id = 'punchlist-attachments'")).rows).toHaveLength(0);
  await expect(db.query('select public.claim_shared_project_area_v2($1,$2,$3)', [project, area, phone])).rejects.toMatchObject({ code: '42501' });
  await expect(db.query('select public.release_abandoned_shared_project_area($1,$2,$3)', [project, area, claim])).rejects.toMatchObject({ code: '42501' });
  await db.exec('reset role; set role anon');
  await expect(db.query('select public.claim_shared_project_area_v2($1,$2,$3)', [project, area, phone])).rejects.toMatchObject({ code: '42501' });
});
