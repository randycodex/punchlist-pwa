create table if not exists public.shared_project_snapshot_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  project_payload jsonb not null,
  payload_version integer not null default 1,
  captured_by_user_id uuid not null references auth.users(id) on delete restrict,
  captured_at timestamptz not null default now(),
  reason text not null default 'manual',
  note text,
  constraint shared_project_snapshot_history_reason_check check (
    reason in ('publish', 'before_publish', 'before_pull', 'manual', 'restore')
  )
);

create index if not exists shared_project_snapshot_history_project_captured_idx
  on public.shared_project_snapshot_history(project_id, captured_at desc);

alter table public.shared_project_snapshot_history enable row level security;

drop policy if exists "project members can read shared project snapshot history"
  on public.shared_project_snapshot_history;
create policy "project members can read shared project snapshot history"
  on public.shared_project_snapshot_history for select
  using (public.can_access_project(project_id));

drop policy if exists "project members can create shared project snapshot history"
  on public.shared_project_snapshot_history;
create policy "project members can create shared project snapshot history"
  on public.shared_project_snapshot_history for insert
  with check (
    public.can_edit_project(project_id)
    and captured_by_user_id = auth.uid()
  );

grant select, insert
  on public.shared_project_snapshot_history
  to authenticated;

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
as $$
declare
  v_user_id uuid := auth.uid();
  v_backup_id uuid;
  v_reason text := coalesce(nullif(trim(p_reason), ''), 'manual');
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
    project_payload,
    payload_version,
    captured_by_user_id,
    reason,
    note
  )
  values (
    p_project_id,
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
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_published_at timestamptz;
  v_current_payload jsonb;
  v_current_payload_version integer;
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

    insert into public.shared_project_snapshot_history (
      project_id,
      project_payload,
      payload_version,
      captured_by_user_id,
      captured_at,
      reason,
      note
    )
    values (
      p_project_id,
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

  insert into public.shared_project_snapshot_history (
    project_id,
    project_payload,
    payload_version,
    captured_by_user_id,
    captured_at,
    reason,
    note
  )
  values (
    p_project_id,
    p_project_payload,
    p_payload_version,
    v_user_id,
    v_next_published_at,
    'publish',
    'Shared data published.'
  );

  return v_next_published_at;
end;
$$;

grant execute on function public.publish_shared_project_snapshot(uuid, jsonb, integer, timestamptz)
  to authenticated;

create or replace function public.list_my_shared_projects()
returns table (
  project_id uuid,
  project_name text,
  owner_user_id uuid,
  owner_email text,
  joined_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sp.id as project_id,
    sp.project_name,
    sp.owner_user_id,
    owner_member.email as owner_email,
    pm.joined_at,
    sps.published_at,
    sp.updated_at
  from public.project_members pm
  join public.shared_projects sp
    on sp.id = pm.project_id
  left join public.project_members owner_member
    on owner_member.project_id = sp.id
    and owner_member.user_id = sp.owner_user_id
    and owner_member.access_state <> 'removed'
  left join public.shared_project_snapshots sps
    on sps.project_id = sp.id
  where auth.uid() is not null
    and pm.access_state = 'active'
    and sp.archived_at is null
    and (
      pm.user_id = auth.uid()
      or lower(pm.email) = public.current_user_email()
    )
  order by coalesce(sps.published_at, sp.updated_at) desc, sp.project_name asc;
$$;

grant execute on function public.list_my_shared_projects()
  to authenticated;

notify pgrst, 'reload schema';
