-- Durable device recovery uploads may commit before a phone receives the reply.
-- Preserve the original history row and return its ID on a later retry.
alter table public.shared_project_snapshot_history
  add column if not exists device_recovery_id uuid;

create unique index if not exists shared_project_snapshot_history_device_recovery_idx
  on public.shared_project_snapshot_history(project_id, device_recovery_id)
  where device_recovery_id is not null;

create or replace function public.capture_shared_project_device_backup(
  p_project_id uuid,
  p_device_recovery_id uuid,
  p_project_payload jsonb,
  p_payload_version integer default 1,
  p_reason text default 'manual',
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
set statement_timeout to '60s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_backup_id uuid;
  v_existing public.shared_project_snapshot_history%rowtype;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'manual');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_user_id is null then
    raise exception 'Shared project backups require an authenticated user.' using errcode = '42501';
  end if;
  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to back up this shared project.' using errcode = '42501';
  end if;
  if p_device_recovery_id is null then
    raise exception 'A device recovery ID is required.' using errcode = '22023';
  end if;

  -- Serialize retries before invoking the existing guarded backup RPC. This
  -- covers the insert and key assignment in one transaction, including callers
  -- whose prior successful response was lost.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_project_id::text || ':' || p_device_recovery_id::text, 0
  ));
  select * into v_existing
  from public.shared_project_snapshot_history
  where project_id = p_project_id and device_recovery_id = p_device_recovery_id;
  if found then
    if v_existing.captured_by_user_id <> v_user_id then
      raise exception 'This device recovery ID belongs to another inspector.' using errcode = '42501';
    end if;
    if v_existing.project_payload is distinct from p_project_payload
      or v_existing.payload_version is distinct from p_payload_version
      or v_existing.reason is distinct from v_reason
      or v_existing.note is distinct from v_note then
      raise exception 'This device recovery ID already belongs to a different backup.' using errcode = '22023';
    end if;
    return v_existing.id;
  end if;

  -- Reuse all existing authorization, reason and payload constraints rather
  -- than creating a second path with different backup authority.
  v_backup_id := public.capture_shared_project_backup(
    p_project_id, p_project_payload, p_payload_version, p_reason, p_note
  );
  update public.shared_project_snapshot_history
    set device_recovery_id = p_device_recovery_id
    where id = v_backup_id;
  return v_backup_id;
end;
$$;

revoke all on function public.capture_shared_project_device_backup(uuid, uuid, jsonb, integer, text, text)
  from public, anon;
grant execute on function public.capture_shared_project_device_backup(uuid, uuid, jsonb, integer, text, text)
  to authenticated;
notify pgrst, 'reload schema';
