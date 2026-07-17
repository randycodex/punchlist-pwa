-- Keep the full project snapshot as a baseline and publish ordinary field work
-- as one compact current row per area. The RPC is idempotent, rejects stale
-- revisions, and serializes with full-project publishing so neither path can
-- silently overwrite a concurrent update.

create table public.shared_project_area_snapshots (
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  area_id uuid not null,
  area_payload jsonb not null,
  payload_version integer not null default 1,
  version integer not null default 1,
  published_by_user_id uuid not null references auth.users(id) on delete restrict,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, area_id),
  constraint shared_project_area_snapshots_version_check check (version > 0),
  constraint shared_project_area_snapshots_payload_version_check check (payload_version in (1, 2))
);

create index shared_project_area_snapshots_project_published_idx
  on public.shared_project_area_snapshots(project_id, published_at desc);

create unique index collaboration_mutations_project_client_idx
  on public.collaboration_mutations(project_id, client_id);

alter table public.shared_project_area_snapshots enable row level security;

create policy "project members can read area snapshots"
  on public.shared_project_area_snapshots for select
  using (public.can_access_project(project_id));

create trigger shared_project_area_snapshots_set_updated_at
  before update on public.shared_project_area_snapshots
  for each row execute function public.set_updated_at();

grant select on public.shared_project_area_snapshots to authenticated;

create or replace function public.publish_shared_project_area_snapshot(
  p_project_id uuid,
  p_area_id uuid,
  p_area_payload jsonb,
  p_payload_version integer default 1,
  p_base_version integer default 0,
  p_base_published_at timestamptz default null,
  p_client_id text default null
)
returns table (
  area_version integer,
  published_at timestamptz
)
language plpgsql
security definer
set search_path = public
set statement_timeout to '60s'
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_version integer := 0;
  v_current_published_at timestamptz;
  v_next_version integer;
  v_next_published_at timestamptz := now();
  v_existing_entity_id uuid;
  v_payload_areas jsonb;
begin
  if v_user_id is null then
    raise exception 'Shared area syncing requires an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to sync this shared area.' using errcode = '42501';
  end if;

  if p_area_id is null or p_base_version is null or p_base_version < 0 then
    raise exception 'Shared area revision input is invalid.' using errcode = '22023';
  end if;

  if p_payload_version not in (1, 2) or jsonb_typeof(p_area_payload) <> 'object' then
    raise exception 'Shared area payload is invalid.' using errcode = '22023';
  end if;

  if nullif(trim(coalesce(p_client_id, '')), '') is null or length(p_client_id) > 128 then
    raise exception 'Shared area sync requires an idempotency key.' using errcode = '22023';
  end if;

  v_payload_areas := coalesce(p_area_payload -> 'areas', p_area_payload -> 'project' -> 'areas');
  if jsonb_typeof(v_payload_areas) is distinct from 'array' then
    raise exception 'Shared area payload does not contain an area list.' using errcode = '22023';
  end if;
  if jsonb_array_length(v_payload_areas) <> 1
    or coalesce(v_payload_areas -> 0 ->> 'id', '') <> p_area_id::text
  then
    raise exception 'Shared area payload does not match its area id.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.shared_project_snapshots where project_id = p_project_id
  ) then
    raise exception 'Publish the shared project once before syncing individual areas.' using errcode = '55000';
  end if;

  -- Full and area publishes take the same short project-scoped transaction
  -- lock. Object uploads happen before this RPC, so unrelated field work only
  -- waits for the database commit, not for media transfer.
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

  select entity_id
    into v_existing_entity_id
    from public.collaboration_mutations
    where project_id = p_project_id
      and client_id = p_client_id
      and status = 'accepted'
    limit 1;

  if found then
    if v_existing_entity_id <> p_area_id then
      raise exception 'Shared area idempotency key belongs to another area.' using errcode = '22023';
    end if;
    return query
      select version, shared_project_area_snapshots.published_at
      from public.shared_project_area_snapshots
      where project_id = p_project_id and area_id = p_area_id;
    return;
  end if;

  if exists (
    select 1
    from public.area_claims
    where project_id = p_project_id
      and area_id = p_area_id
      and status = 'active'
      and (expires_at is null or expires_at > now())
      and claimed_by_user_id <> v_user_id
  ) then
    raise exception 'Another member is editing this shared area.' using errcode = '55P03';
  end if;

  select version, shared_project_area_snapshots.published_at
    into v_current_version, v_current_published_at
    from public.shared_project_area_snapshots
    where project_id = p_project_id and area_id = p_area_id
    for update;

  if not found then
    v_current_version := 0;
    v_current_published_at := null;
  end if;

  if v_current_version <> p_base_version
    and not (
      p_base_version = 0
      and p_base_published_at is not null
      and v_current_published_at is not null
      and v_current_published_at <= p_base_published_at
    )
  then
    raise exception 'Shared area has newer team data. Pull shared data before syncing again.' using errcode = '40001';
  end if;

  v_next_version := v_current_version + 1;

  insert into public.shared_project_area_snapshots (
    project_id,
    area_id,
    area_payload,
    payload_version,
    version,
    published_by_user_id,
    published_at
  )
  values (
    p_project_id,
    p_area_id,
    p_area_payload,
    p_payload_version,
    v_next_version,
    v_user_id,
    v_next_published_at
  )
  on conflict (project_id, area_id) do update
    set area_payload = excluded.area_payload,
        payload_version = excluded.payload_version,
        version = excluded.version,
        published_by_user_id = excluded.published_by_user_id,
        published_at = excluded.published_at;

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
    'area',
    p_area_id,
    case when v_current_version = 0 then 'create' else 'update' end,
    jsonb_build_object('areaVersion', v_next_version, 'payloadVersion', p_payload_version),
    p_base_version,
    v_user_id,
    p_client_id,
    'accepted',
    v_next_published_at,
    v_next_published_at
  );

  area_version := v_next_version;
  published_at := v_next_published_at;
  return next;
end;
$$;

grant execute on function public.publish_shared_project_area_snapshot(
  uuid, uuid, jsonb, integer, integer, timestamptz, text
) to authenticated;

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
  v_latest_area_published_at timestamptz;
  v_current_payload jsonb;
  v_current_payload_version integer;
  v_current_project_name text;
  v_has_snapshot boolean := false;
  v_next_published_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'Shared project publishing requires an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to publish this shared project.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));

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

  if v_has_snapshot then
    if p_base_published_at is null
      or v_current_published_at > p_base_published_at + interval '2 seconds'
    then
      raise exception 'Shared project has newer published data. Pull shared data before publishing again.' using errcode = '40001';
    end if;

    if v_latest_area_published_at is not null
      and (
        p_base_published_at is null
        or v_latest_area_published_at > p_base_published_at + interval '2 seconds'
      )
    then
      raise exception 'Shared project has newer area data. Pull shared data before publishing again.' using errcode = '40001';
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
    greatest(sps.published_at, area_updates.published_at) as published_at,
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
  where auth.uid() is not null
    and pm.access_state = 'active'
    and sp.archived_at is null
    and (
      pm.user_id = auth.uid()
      or lower(pm.email) = public.current_user_email()
    )
  order by coalesce(greatest(sps.published_at, area_updates.published_at), sp.updated_at) desc,
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
      and tablename = 'shared_project_area_snapshots'
  ) then
    alter publication supabase_realtime add table public.shared_project_area_snapshots;
  end if;
end $$;

notify pgrst, 'reload schema';
