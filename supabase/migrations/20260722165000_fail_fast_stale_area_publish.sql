-- A stale area publish cannot succeed, even after waiting for the project-wide
-- publish lock. Detect that case before waiting so offline retries receive the
-- actionable 40001 conflict instead of timing out as a connection failure.
-- Keep the checks after the lock as well because another publisher can commit
-- between the optimistic check and lock acquisition.

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
  v_existing_version integer;
  v_existing_published_at timestamptz;
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

  -- Preserve idempotent retry behavior before the optimistic stale check.
  select
      entity_id,
      case
        when coalesce(patch ->> 'areaVersion', '') ~ '^[0-9]+$'
          then (patch ->> 'areaVersion')::integer
        else null
      end,
      accepted_at
    into v_existing_entity_id, v_existing_version, v_existing_published_at
    from public.collaboration_mutations
    where project_id = p_project_id
      and client_id = p_client_id
      and status = 'accepted'
    limit 1;

  if found then
    if v_existing_entity_id <> p_area_id then
      raise exception 'Shared area idempotency key belongs to another area.' using errcode = '22023';
    end if;
    if v_existing_version is null or v_existing_published_at is null then
      raise exception 'Shared area idempotency record is incomplete.' using errcode = '55000';
    end if;
    area_version := v_existing_version;
    published_at := v_existing_published_at;
    return next;
    return;
  end if;

  select version, shared_project_area_snapshots.published_at
    into v_current_version, v_current_published_at
    from public.shared_project_area_snapshots
    where project_id = p_project_id and area_id = p_area_id;

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

  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  v_next_published_at := clock_timestamp();

  -- Repeat both checks after serialization to close the optimistic race.
  select
      entity_id,
      case
        when coalesce(patch ->> 'areaVersion', '') ~ '^[0-9]+$'
          then (patch ->> 'areaVersion')::integer
        else null
      end,
      accepted_at
    into v_existing_entity_id, v_existing_version, v_existing_published_at
    from public.collaboration_mutations
    where project_id = p_project_id
      and client_id = p_client_id
      and status = 'accepted'
    limit 1;

  if found then
    if v_existing_entity_id <> p_area_id then
      raise exception 'Shared area idempotency key belongs to another area.' using errcode = '22023';
    end if;
    if v_existing_version is null or v_existing_published_at is null then
      raise exception 'Shared area idempotency record is incomplete.' using errcode = '55000';
    end if;
    area_version := v_existing_version;
    published_at := v_existing_published_at;
    return next;
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

notify pgrst, 'reload schema';
