-- Compact snapshot payloads keep binary data in the existing private storage
-- bucket. Keep backup-list metadata beside the payload so listing recovery
-- points never downloads up to 50 complete historical projects.

alter table public.shared_project_snapshot_history
  add column if not exists project_name text;

update public.shared_project_snapshot_history
set project_name = coalesce(
  nullif(trim(project_payload ->> 'projectName'), ''),
  nullif(trim((project_payload -> 'project') ->> 'projectName'), ''),
  'Shared project backup'
)
where project_name is null or trim(project_name) = '';

alter table public.shared_project_snapshot_history
  alter column project_name set default 'Shared project backup';

alter table public.shared_project_snapshot_history
  alter column project_name set not null;

create index if not exists shared_attachments_project_updated_idx
  on public.shared_attachments(project_id, updated_at desc)
  where deleted_at is null;

create or replace function public.capture_shared_project_backup(
  p_project_id uuid,
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
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'manual');
  v_project_name text := coalesce(
    nullif(trim(p_project_payload ->> 'projectName'), ''),
    nullif(trim((p_project_payload -> 'project') ->> 'projectName'), ''),
    'Shared project backup'
  );
begin
  if v_user_id is null then
    raise exception 'Shared project backups require an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to back up this shared project.' using errcode = '42501';
  end if;

  if v_reason not in ('publish', 'before_publish', 'before_pull', 'manual', 'restore') then
    raise exception 'Unsupported shared project backup reason.' using errcode = '22023';
  end if;

  insert into public.shared_project_snapshot_history (
    project_id,
    project_name,
    project_payload,
    payload_version,
    captured_by_user_id,
    reason,
    note
  )
  values (
    p_project_id,
    v_project_name,
    p_project_payload,
    p_payload_version,
    v_user_id,
    v_reason,
    nullif(trim(coalesce(p_note, '')), '')
  )
  returning id into v_backup_id;

  return v_backup_id;
end;
$$;

grant execute on function public.capture_shared_project_backup(uuid, jsonb, integer, text, text)
  to authenticated;

create or replace function public.publish_shared_project_snapshot(
  p_project_id uuid,
  p_project_payload jsonb,
  p_payload_version integer default 1,
  p_base_published_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
set statement_timeout to '60s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_published_at timestamptz;
  v_current_payload jsonb;
  v_current_payload_version integer;
  v_current_project_name text;
  v_next_published_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'Shared project publishing requires an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to publish this shared project.' using errcode = '42501';
  end if;

  select published_at, project_payload, payload_version
    into v_current_published_at, v_current_payload, v_current_payload_version
    from public.shared_project_snapshots
    where project_id = p_project_id
    for update;

  if found then
    if p_base_published_at is not null
      and v_current_published_at > p_base_published_at + interval '2 seconds'
    then
      raise exception 'Shared project has newer published data. Pull shared data before publishing again.' using errcode = '40001';
    end if;

    v_current_project_name := coalesce(
      nullif(trim(v_current_payload ->> 'projectName'), ''),
      nullif(trim((v_current_payload -> 'project') ->> 'projectName'), ''),
      'Shared project backup'
    );

    insert into public.shared_project_snapshot_history (
      project_id,
      project_name,
      project_payload,
      payload_version,
      captured_by_user_id,
      captured_at,
      reason,
      note
    )
    values (
      p_project_id,
      v_current_project_name,
      v_current_payload,
      v_current_payload_version,
      v_user_id,
      v_current_published_at,
      'before_publish',
      'Latest shared data before this publish.'
    );

    update public.shared_project_snapshots
      set project_payload = p_project_payload,
          payload_version = p_payload_version,
          published_by_user_id = v_user_id,
          published_at = v_next_published_at
      where project_id = p_project_id;
  else
    insert into public.shared_project_snapshots (
      project_id,
      project_payload,
      payload_version,
      published_by_user_id,
      published_at
    )
    values (
      p_project_id,
      p_project_payload,
      p_payload_version,
      v_user_id,
      v_next_published_at
    );
  end if;

  return v_next_published_at;
end;
$$;

grant execute on function public.publish_shared_project_snapshot(uuid, jsonb, integer, timestamptz)
  to authenticated;

notify pgrst, 'reload schema';
