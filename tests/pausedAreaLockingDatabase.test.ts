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

describe('paused area locking', () => {
  it('acknowledges old-client claims without reserving an area', async () => {
    expect((await db.query<{ enabled: boolean }>('select public.area_locking_enabled() as enabled')).rows[0].enabled).toBe(false);
    for (const [user, email] of [[member, 'member@uai-ny.com'], [owner, 'owner@uai-ny.com']]) {
      await signIn(user, email);
      const result = (await db.query<{ result: { locking_enabled: boolean } }>('select public.claim_shared_project_area_v2($1,$2,$3) as result', [project, area, phone])).rows[0].result;
      expect(result.locking_enabled).toBe(false);
    }
    expect((await db.query("select id from public.area_claims where status='active'")).rows).toHaveLength(0);
  });
  it('allows both members to save but rejects stale edits and keeps retries idempotent', async () => {
    const payload = { id: localProject, areas: [{ id: area, notes: 'Accepted inspection', locations: [] }] };
    const sql = 'select * from public.publish_shared_project_area_snapshot($1,$2,$3,1,$4,null,$5,$6)';
    await signIn(member, 'member@uai-ny.com');
    const first = (await db.query(sql, [project, area, payload, 0, 'first', phone])).rows;
    expect((await db.query(sql, [project, area, payload, 0, 'first', phone])).rows).toEqual(first);
    await signIn(owner, 'owner@uai-ny.com');
    await expect(db.query(sql, [project, area, { ...payload, notes: 'stale' }, 0, 'stale', computer])).rejects.toMatchObject({ code: 'PT409' });
    expect((await db.query<{ area_version: number }>(sql, [project, area, payload, 1, 'second', computer])).rows[0].area_version).toBe(2);
    expect((await db.query("select id from public.area_claims where status='active'")).rows).toHaveLength(0);
    await expect(db.query('select * from public.publish_shared_project_area_snapshot_internal($1,$2,$3,1,2,null,$4)', [project, area, payload, 'bypass'])).rejects.toMatchObject({ code: '42501' });
  });
  it('still denies outsiders and anonymous callers', async () => {
    const outsider = crypto.randomUUID();
    await db.exec('reset role');
    await db.query('insert into auth.users(id,email) values ($1,$2)', [outsider, 'outsider@example.com']);
    await signIn(outsider, 'outsider@example.com');
    await expect(db.query('select public.claim_shared_project_area_v2($1,$2,$3)', [project, area, phone])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query('select * from public.publish_shared_project_area_snapshot($1,$2,$3,1,2,null,$4,$5)', [project, area, { areas: [] }, 'outsider', phone])).rejects.toMatchObject({ code: '42501' });
    await db.exec('reset role; set role anon');
    await expect(db.query('select public.claim_shared_project_area_v2($1,$2,$3)', [project, area, phone])).rejects.toMatchObject({ code: '42501' });
  });
});
