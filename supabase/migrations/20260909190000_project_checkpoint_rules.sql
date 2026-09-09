-- Add shared checkpoint template rules using existing metadata version/conflict checks.
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

  if octet_length(p_metadata_payload::text) > 131072 then
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
      'facadeLevelStart', 'facadeLevelEnd', 'checkpointRules'
    ])
  ) then
    raise exception 'Shared project metadata payload contains unsupported fields.' using errcode = '22023';
  end if;

  if p_metadata_payload ? 'checkpointRules' then
    if jsonb_typeof(p_metadata_payload -> 'checkpointRules') <> 'array' then
      raise exception 'Checkpoint rules must be an array.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_metadata_payload -> 'checkpointRules') > 100 then
      raise exception 'Use no more than 100 checkpoint rules.' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_metadata_payload -> 'checkpointRules') as rule
      where jsonb_typeof(rule) <> 'object'
        or not (rule ?& array['room', 'item', 'name'])
        or jsonb_typeof(rule -> 'room') <> 'string'
        or jsonb_typeof(rule -> 'item') <> 'string'
        or jsonb_typeof(rule -> 'name') <> 'string'
        or length(trim(rule ->> 'room')) not between 1 and 200
        or length(trim(rule ->> 'item')) not between 1 and 200
        or length(trim(rule ->> 'name')) not between 1 and 200
    ) then
      raise exception 'Invalid checkpoint rule.' using errcode = '22023';
    end if;
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
  -- Older clients editing project details must not erase project checkpoint rules.
  if not (p_metadata_payload ? 'checkpointRules') then
    p_metadata_payload := p_metadata_payload || coalesce(
      (select jsonb_build_object('checkpointRules', metadata_payload -> 'checkpointRules')
       from public.shared_project_metadata_snapshots where project_id = p_project_id
         and metadata_payload ? 'checkpointRules'), '{}'::jsonb);
  end if;
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

notify pgrst, 'reload schema';
