-- Keep frequently edited project details out of the full snapshot path. One
-- compact, versioned row is authoritative for current project metadata while
-- the full snapshot remains the baseline and recovery artifact.

create table public.shared_project_metadata_snapshots (
  project_id uuid primary key references public.shared_projects(id) on delete cascade,
  metadata_payload jsonb not null,
  payload_version integer not null default 1,
  version integer not null default 1,
  published_by_user_id uuid not null references auth.users(id) on delete restrict,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_project_metadata_snapshots_version_check check (version > 0),
  constraint shared_project_metadata_snapshots_payload_version_check check (payload_version = 1)
);

alter table public.shared_project_metadata_snapshots enable row level security;

create policy "project members can read metadata snapshots"
  on public.shared_project_metadata_snapshots for select
  using (public.can_access_project(project_id));

create trigger shared_project_metadata_snapshots_set_updated_at
  before update on public.shared_project_metadata_snapshots
  for each row execute function public.set_updated_at();

grant select on public.shared_project_metadata_snapshots to authenticated;

create or replace function public.publish_shared_project_metadata_snapshot(
  p_project_id uuid,
  p_metadata_payload jsonb,
  p_payload_version integer default 1,
  p_base_version integer default 0,
  p_client_id text default null
)
returns table (
  metadata_version integer,
  published_at timestamptz
)
language plpgsql
security definer
set search_path = public
set statement_timeout to '20s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_version integer := 0;
  v_next_version integer;
  v_next_published_at timestamptz;
  v_existing_entity_type text;
  v_existing_entity_id uuid;
  v_existing_version integer;
  v_existing_published_at timestamptz;
begin
  if v_user_id is null then
    raise exception 'Shared project metadata syncing requires an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to sync this shared project metadata.' using errcode = '42501';
  end if;

  if p_project_id is null or p_base_version is null or p_base_version < 0 then
    raise exception 'Shared project metadata revision input is invalid.' using errcode = '22023';
  end if;

  if p_payload_version <> 1 or jsonb_typeof(p_metadata_payload) <> 'object' then
    raise exception 'Shared project metadata payload is invalid.' using errcode = '22023';
  end if;

  if octet_length(p_metadata_payload::text) > 16384 then
    raise exception 'Shared project metadata payload is too large.' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_client_id, '')), '') is null or length(p_client_id) > 128 then
    raise exception 'Shared project metadata sync requires an idempotency key.' using errcode = '22023';
  end if;

  if not p_metadata_payload ?& array[
    'projectName', 'address', 'date', 'inspector', 'gcName', 'gcSignoff',
    'facadeLevelStart', 'facadeLevelEnd'
  ] then
    raise exception 'Shared project metadata payload is missing required fields.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_metadata_payload) as payload_key(key)
    where payload_key.key <> all (array[
      'projectName', 'address', 'date', 'inspector', 'gcName', 'gcSignoff',
      'facadeLevelStart', 'facadeLevelEnd'
    ])
  ) then
    raise exception 'Shared project metadata payload contains unsupported fields.' using errcode = '22023';
  end if;

  if jsonb_typeof(p_metadata_payload -> 'projectName') <> 'string'
    or nullif(trim(p_metadata_payload ->> 'projectName'), '') is null
    or length(p_metadata_payload ->> 'projectName') > 200
    or jsonb_typeof(p_metadata_payload -> 'address') <> 'string'
    or length(p_metadata_payload ->> 'address') > 500
    or jsonb_typeof(p_metadata_payload -> 'date') <> 'string'
    or jsonb_typeof(p_metadata_payload -> 'inspector') <> 'string'
    or length(p_metadata_payload ->> 'inspector') > 200
    or jsonb_typeof(p_metadata_payload -> 'gcName') <> 'string'
    or length(p_metadata_payload ->> 'gcName') > 200
    or jsonb_typeof(p_metadata_payload -> 'gcSignoff') <> 'string'
    or length(p_metadata_payload ->> 'gcSignoff') > 500
    or jsonb_typeof(p_metadata_payload -> 'facadeLevelStart') not in ('number', 'null')
    or jsonb_typeof(p_metadata_payload -> 'facadeLevelEnd') not in ('number', 'null')
  then
    raise exception 'Shared project metadata fields are invalid.' using errcode = '22023';
  end if;

  begin
    perform (p_metadata_payload ->> 'date')::timestamptz;
    if p_metadata_payload -> 'facadeLevelStart' <> 'null'::jsonb
      and abs((p_metadata_payload ->> 'facadeLevelStart')::numeric) > 10000
    then
      raise exception 'Facade level start is outside the supported range.' using errcode = '22023';
    end if;
    if p_metadata_payload -> 'facadeLevelEnd' <> 'null'::jsonb
      and abs((p_metadata_payload ->> 'facadeLevelEnd')::numeric) > 10000
    then
      raise exception 'Facade level end is outside the supported range.' using errcode = '22023';
    end if;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
      raise exception 'Shared project metadata date or level range is invalid.' using errcode = '22023';
  end;

  if not exists (
    select 1 from public.shared_project_snapshots where project_id = p_project_id
  ) then
    raise exception 'Publish the shared project once before syncing project metadata.' using errcode = '55000';
  end if;

  -- Serialize metadata, area, and full publishes with the same project lock.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  v_next_published_at := clock_timestamp();

  select
      entity_type,
      entity_id,
      case
        when coalesce(patch ->> 'metadataVersion', '') ~ '^[0-9]+$'
          then (patch ->> 'metadataVersion')::integer
        else null
      end,
      accepted_at
    into
      v_existing_entity_type,
      v_existing_entity_id,
      v_existing_version,
      v_existing_published_at
    from public.collaboration_mutations
    where project_id = p_project_id
      and client_id = p_client_id
      and status = 'accepted'
    limit 1;

  if found then
    if v_existing_entity_type <> 'project' or v_existing_entity_id <> p_project_id then
      raise exception 'Shared project metadata idempotency key belongs to another entity.' using errcode = '22023';
    end if;
    if v_existing_version is null or v_existing_published_at is null then
      raise exception 'Shared project metadata idempotency record is incomplete.' using errcode = '55000';
    end if;
    metadata_version := v_existing_version;
    published_at := v_existing_published_at;
    return next;
    return;
  end if;

  select version
    into v_current_version
    from public.shared_project_metadata_snapshots
    where project_id = p_project_id
    for update;
  if not found then
    v_current_version := 0;
  end if;

  if v_current_version <> p_base_version then
    raise exception 'Shared project metadata has newer team data. Pull shared data before syncing again.' using errcode = '40001';
  end if;

  v_next_version := v_current_version + 1;

  insert into public.shared_project_metadata_snapshots (
    project_id,
    metadata_payload,
    payload_version,
    version,
    published_by_user_id,
    published_at
  )
  values (
    p_project_id,
    p_metadata_payload,
    p_payload_version,
    v_next_version,
    v_user_id,
    v_next_published_at
  )
  on conflict (project_id) do update
    set metadata_payload = excluded.metadata_payload,
        payload_version = excluded.payload_version,
        version = excluded.version,
        published_by_user_id = excluded.published_by_user_id,
        published_at = excluded.published_at;

  update public.shared_projects
    set project_name = trim(p_metadata_payload ->> 'projectName')
    where id = p_project_id;

  insert into public.collaboration_mutations (
    project_id,
    entity_type,
    entity_id,
    action,
    patch,
    base_version,
    author_user_id,
    client_id,
    status,
    sent_at,
    accepted_at
  )
  values (
    p_project_id,
    'project',
    p_project_id,
    'update',
    jsonb_build_object('metadataVersion', v_next_version, 'payloadVersion', p_payload_version),
    p_base_version,
    v_user_id,
    p_client_id,
    'accepted',
    v_next_published_at,
    v_next_published_at
  );

  metadata_version := v_next_version;
  published_at := v_next_published_at;
  return next;
end;
$$;

grant execute on function public.publish_shared_project_metadata_snapshot(
  uuid, jsonb, integer, integer, text
) to authenticated;

-- Replace the full publish RPC so a full baseline cannot race past unseen
-- metadata. Metadata remains an independent overlay, but the submitted base
-- version proves this client observed the current row.
drop function public.publish_shared_project_snapshot(uuid, jsonb, integer, timestamptz);

create function public.publish_shared_project_snapshot(
  p_project_id uuid,
  p_project_payload jsonb,
  p_payload_version integer default 1,
  p_base_published_at timestamptz default null,
  p_base_metadata_version integer default 0
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
  v_latest_area_published_at timestamptz;
  v_current_metadata_version integer := 0;
  v_current_payload jsonb;
  v_current_payload_version integer;
  v_current_project_name text;
  v_has_snapshot boolean := false;
  v_next_published_at timestamptz;
  v_payload_areas jsonb;
begin
  if v_user_id is null then
    raise exception 'Shared project publishing requires an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to publish this shared project.' using errcode = '42501';
  end if;

  if p_payload_version not in (1, 2) or jsonb_typeof(p_project_payload) <> 'object' then
    raise exception 'Shared project payload is invalid.' using errcode = '22023';
  end if;
  if p_base_metadata_version is null or p_base_metadata_version < 0 then
    raise exception 'Shared project metadata revision input is invalid.' using errcode = '22023';
  end if;
  v_payload_areas := coalesce(
    p_project_payload -> 'areas',
    p_project_payload -> 'project' -> 'areas'
  );
  if jsonb_typeof(v_payload_areas) is distinct from 'array' then
    raise exception 'Shared project payload does not contain an area list.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  v_next_published_at := clock_timestamp();

  select published_at, project_payload, payload_version
    into v_current_published_at, v_current_payload, v_current_payload_version
    from public.shared_project_snapshots
    where project_id = p_project_id
    for update;
  v_has_snapshot := found;

  select max(published_at)
    into v_latest_area_published_at
    from public.shared_project_area_snapshots
    where project_id = p_project_id;

  select version
    into v_current_metadata_version
    from public.shared_project_metadata_snapshots
    where project_id = p_project_id
    for update;
  if not found then
    v_current_metadata_version := 0;
  end if;

  if v_current_metadata_version <> p_base_metadata_version then
    raise exception 'Shared project has newer metadata. Pull shared data before publishing again.' using errcode = '40001';
  end if;

  if v_has_snapshot then
    if p_base_published_at is null
      or v_current_published_at > p_base_published_at
    then
      raise exception 'Shared project has newer published data. Pull shared data before publishing again.' using errcode = '40001';
    end if;

    if v_latest_area_published_at is not null
      and (
        p_base_published_at is null
        or v_latest_area_published_at > p_base_published_at
      )
    then
      raise exception 'Shared project has newer area data. Pull shared data before publishing again.' using errcode = '40001';
    end if;

    if exists (
      select 1
      from public.shared_project_area_snapshots area_snapshot
      where area_snapshot.project_id = p_project_id
        and area_snapshot.published_at > v_current_published_at
        and not exists (
          select 1
          from jsonb_array_elements(v_payload_areas) as payload_area(value)
          where payload_area.value ->> 'id' = area_snapshot.area_id::text
            and case
              when coalesce(payload_area.value ->> 'sharedVersion', '') ~ '^[0-9]+$'
                then (payload_area.value ->> 'sharedVersion')::integer
              else -1
            end >= area_snapshot.version
        )
    ) then
      raise exception 'Shared project payload is missing newer area revisions. Pull shared data before publishing again.' using errcode = '40001';
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
      'Latest full shared baseline before this publish.'
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

grant execute on function public.publish_shared_project_snapshot(
  uuid, jsonb, integer, timestamptz, integer
) to authenticated;

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
    greatest(sps.published_at, area_updates.published_at, metadata_updates.published_at) as published_at,
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
  left join lateral (
    select max(sas.published_at) as published_at
    from public.shared_project_area_snapshots sas
    where sas.project_id = sp.id
  ) area_updates on true
  left join public.shared_project_metadata_snapshots metadata_updates
    on metadata_updates.project_id = sp.id
  where auth.uid() is not null
    and pm.access_state = 'active'
    and sp.archived_at is null
    and (
      pm.user_id = auth.uid()
      or lower(pm.email) = public.current_user_email()
    )
  order by coalesce(
      greatest(sps.published_at, area_updates.published_at, metadata_updates.published_at),
      sp.updated_at
    ) desc,
    sp.project_name asc;
$$;

grant execute on function public.list_my_shared_projects() to authenticated;

do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'shared_project_metadata_snapshots'
  ) then
    alter publication supabase_realtime add table public.shared_project_metadata_snapshots;
  end if;
end $$;

notify pgrst, 'reload schema';
