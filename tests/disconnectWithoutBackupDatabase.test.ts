import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createCollaborationTestDatabase } from './helpers/collaborationDatabase';

const owner = crypto.randomUUID(), member = crypto.randomUUID(), outsider = crypto.randomUUID();
let db: PGlite;

async function signIn(id: string, email: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.email', $2, false)", [id, email]);
  await db.exec('set role authenticated');
}

beforeAll(async () => {
  db = await createCollaborationTestDatabase();
  await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4),($5,$6)',
    [owner, 'owner@uai-ny.com', member, 'member@uai-ny.com', outsider, 'outsider@uai-ny.com']);
}, 30_000);
afterAll(async () => { await db?.close(); });

async function fixture() {
  await signIn(owner, 'owner@uai-ny.com');
  const localId = crypto.randomUUID();
  const project = (await db.query<{ id: string }>('select public.create_shared_project($1,$2,$3) as id',
    [localId, 'Leave without a new backup', 'owner@uai-ny.com'])).rows[0].id;
  const payload = { id: localId, projectName: 'Leave without a new backup', areas: [] };
  await db.query('select public.publish_shared_project_snapshot_v2($1,$2,1,null,0)', [project, payload]);
  const code = (await db.query<{ result: { join_code: string } }>('select public.generate_shared_project_join_code($1) as result', [project])).rows[0].result.join_code;
  await signIn(member, 'member@uai-ny.com');
  await db.query('select public.join_shared_project_by_code($1,$2)', [code, 'member@uai-ny.com']);
  await db.exec('reset role');
  await db.query('insert into public.shared_project_snapshot_history(project_id,project_payload,payload_version,captured_by_user_id) values ($1,$2,1,$3)',
    [project, payload, owner]);
  return { project, payload };
}

async function backups(project: string) {
  await db.exec('reset role');
  return (await db.query('select id,project_payload from public.shared_project_snapshot_history where project_id=$1 order by id', [project])).rows;
}

describe('disconnect RPC without a new backup', () => {
  it('removes only the leaving member and retains the published snapshot and existing backups', async () => {
    const { project, payload } = await fixture();
    const before = await backups(project);
    expect(before.length).toBeGreaterThan(0);
    await signIn(member, 'member@uai-ny.com');
    const result = await db.query<{ result: { action: string } }>('select public.disconnect_shared_project($1) as result', [project]);
    expect(result.rows[0].result.action).toBe('left');
    expect(await backups(project)).toEqual(before);
    expect((await db.query('select archived_at from public.shared_projects where id=$1', [project])).rows).toEqual([{ archived_at: null }]);
    expect((await db.query('select access_state from public.project_members where project_id=$1 and user_id=$2', [project, member])).rows).toEqual([{ access_state: 'removed' }]);
    expect((await db.query('select project_payload from public.shared_project_snapshots where project_id=$1', [project])).rows).toEqual([{ project_payload: payload }]);
    await signIn(owner, 'owner@uai-ny.com');
    expect((await db.query('select id from public.shared_projects where id=$1', [project])).rows).toHaveLength(1);
  });

  it('still denies an unrelated account without changing membership or backups', async () => {
    const { project } = await fixture();
    const before = await backups(project);
    await signIn(outsider, 'outsider@uai-ny.com');
    await expect(db.query('select public.disconnect_shared_project($1)', [project])).rejects.toMatchObject({ code: '42501' });
    expect(await backups(project)).toEqual(before);
    expect((await db.query('select access_state from public.project_members where project_id=$1 and user_id=$2', [project, member])).rows).toEqual([{ access_state: 'active' }]);
  });

  it('still archives the project for everyone when its owner stops sharing', async () => {
    const { project } = await fixture();
    const before = await backups(project);
    await signIn(owner, 'owner@uai-ny.com');
    const result = await db.query<{ result: { action: string } }>('select public.disconnect_shared_project($1) as result', [project]);
    expect(result.rows[0].result.action).toBe('archived');
    expect(await backups(project)).toEqual(before);
    const memberships = (await db.query<{ access_state: string }>('select access_state from public.project_members where project_id=$1', [project])).rows;
    expect(memberships).toHaveLength(2);
    expect(memberships.every((entry) => entry.access_state === 'removed')).toBe(true);
    expect((await db.query<{ archived_at: string }>('select archived_at from public.shared_projects where id=$1', [project])).rows[0].archived_at).not.toBeNull();
  });
});
