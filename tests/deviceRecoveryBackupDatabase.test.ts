import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createCollaborationTestDatabase } from './helpers/collaborationDatabase';

const owner = '00000000-0000-4000-8000-000000000101';
const member = '00000000-0000-4000-8000-000000000102';
const outsider = '00000000-0000-4000-8000-000000000103';
const localProject = '00000000-0000-4000-8000-000000000104';
const payload = { id: localProject, projectName: 'Original device copy', areas: [] };
const captureSql = 'select public.capture_shared_project_device_backup($1,$2,$3,$4,$5,$6) as id';
let db: PGlite;
let project: string;

async function signIn(id: string, email: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.email', $2, false)", [id, email]);
  await db.exec('set role authenticated');
}

async function capture(recoveryId: string, projectId = project, input: unknown = payload, version = 1, reason = 'before_pull', note = 'Before team updates') {
  return (await db.query<{ id: string }>(captureSql, [projectId, recoveryId, input, version, reason, note])).rows[0].id;
}

beforeAll(async () => {
  db = await createCollaborationTestDatabase();
  await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4),($5,$6)', [owner, 'recovery-owner@uai-ny.com', member, 'recovery-member@uai-ny.com', outsider, 'recovery-outsider@uai-ny.com']);
  await signIn(owner, 'recovery-owner@uai-ny.com');
  project = (await db.query<{ id: string }>('select public.create_shared_project($1,$2,$3) as id', [localProject, 'Recovery retry test', 'recovery-owner@uai-ny.com'])).rows[0].id;
  const code = (await db.query<{ result: { join_code: string } }>('select public.generate_shared_project_join_code($1) as result', [project])).rows[0].result.join_code;
  await signIn(member, 'recovery-member@uai-ny.com');
  await db.query('select public.join_shared_project_by_code($1,$2)', [code, 'recovery-member@uai-ny.com']);
}, 30000);
beforeEach(async () => { await signIn(owner, 'recovery-owner@uai-ny.com'); });
afterAll(async () => { await db?.close(); });

describe('immutable idempotent device backup capture', () => {
  it.each(['before_pull', 'manual', 'restore'])('returns one committed history ID after a lost %s response', async (reason) => {
    const recoveryId = crypto.randomUUID();
    const committedId = await capture(recoveryId, project, payload, 1, reason);
    const replies = await Promise.all([capture(recoveryId, project, payload, 1, reason), capture(recoveryId, project, payload, 1, reason)]);
    expect(replies).toEqual([committedId, committedId]);
    const rows = (await db.query<{ id: string; project_payload: unknown; captured_by_user_id: string }>('select id,project_payload,captured_by_user_id from public.shared_project_snapshot_history where project_id=$1 and device_recovery_id=$2', [project, recoveryId])).rows;
    expect(rows).toEqual([{ id: committedId, project_payload: payload, captured_by_user_id: owner }]);
  });

  it('rejects changed contents or reason under the same recovery ID without changing the saved copy', async () => {
    const recoveryId = crypto.randomUUID();
    const committedId = await capture(recoveryId);
    for (const args of [
      [project, recoveryId, { ...payload, projectName: 'Changed' }, 1, 'before_pull', 'Before team updates'],
      [project, recoveryId, payload, 2, 'before_pull', 'Before team updates'],
      [project, recoveryId, payload, 1, 'restore', 'Before team updates'],
      [project, recoveryId, payload, 1, 'before_pull', 'Different note'],
    ]) {
      await expect(db.query(captureSql, args)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await capture(recoveryId)).toBe(committedId);
    await expect(db.query('update public.shared_project_snapshot_history set device_recovery_id=$1 where id=$2', [crypto.randomUUID(), committedId])).rejects.toMatchObject({ code: '42501' });
  });

  it('scopes recovery IDs to their shared project while keeping legacy captures compatible', async () => {
    const recoveryId = crypto.randomUUID();
    const first = await capture(recoveryId);
    const secondProject = (await db.query<{ id: string }>('select public.create_shared_project($1,$2,$3) as id', [crypto.randomUUID(), 'Another project', 'recovery-owner@uai-ny.com'])).rows[0].id;
    const second = await capture(recoveryId, secondProject);
    expect(second).not.toBe(first);
    const legacySql = 'select public.capture_shared_project_backup($1,$2,1,$3,$4) as id';
    const legacyFirst = (await db.query<{ id: string }>(legacySql, [project, payload, 'manual', null])).rows[0].id;
    const legacySecond = (await db.query<{ id: string }>(legacySql, [project, payload, 'manual', null])).rows[0].id;
    expect(legacySecond).not.toBe(legacyFirst);
    expect((await db.query<{ device_recovery_id: string | null }>('select device_recovery_id from public.shared_project_snapshot_history where id=$1', [legacyFirst])).rows[0].device_recovery_id).toBeNull();
  });

  it('preserves the existing reason and payload guards and requires a stable recovery ID', async () => {
    await expect(capture(crypto.randomUUID(), project, payload, 1, 'unsupported')).rejects.toMatchObject({ code: '22023' });
    await expect(capture(crypto.randomUUID(), project, null)).rejects.toMatchObject({ code: '23502' });
    await expect(db.query(captureSql, [project, null, payload, 1, 'before_pull', null])).rejects.toMatchObject({ code: '22023' });
    await db.exec('reset role; set role anon');
    await expect(capture(crypto.randomUUID())).rejects.toMatchObject({ code: '42501' });
    await signIn('', '');
    await expect(capture(crypto.randomUUID())).rejects.toMatchObject({ code: '42501' });
  });

  it('checks membership and original creator even when a recovery ID already exists', async () => {
    const recoveryId = crypto.randomUUID();
    await capture(recoveryId);
    await signIn(outsider, 'recovery-outsider@uai-ny.com');
    await expect(capture(recoveryId)).rejects.toMatchObject({ code: '42501' });
    await signIn(member, 'recovery-member@uai-ny.com');
    await expect(capture(recoveryId)).rejects.toMatchObject({ code: '42501' });
    const memberRecoveryId = crypto.randomUUID();
    const memberBackupId = await capture(memberRecoveryId);
    await signIn(owner, 'recovery-owner@uai-ny.com');
    await db.query('select public.remove_shared_project_member($1,$2)', [project, 'recovery-member@uai-ny.com']);
    await signIn(member, 'recovery-member@uai-ny.com');
    await expect(capture(memberRecoveryId)).rejects.toMatchObject({ code: '42501' });
    await signIn(owner, 'recovery-owner@uai-ny.com');
    expect((await db.query('select id from public.shared_project_snapshot_history where id=$1', [memberBackupId])).rows).toHaveLength(1);
  });
});
