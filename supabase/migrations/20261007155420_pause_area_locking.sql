-- Pause exclusive area ownership. Membership, version and idempotency checks remain.
-- Re-enable deliberately with a new migration and AREA_LOCKING_ENABLED in the app.
create or replace function public.area_locking_enabled()
returns boolean language sql immutable set search_path = '' as $$ select false $$;
revoke all on function public.area_locking_enabled() from public, anon;
grant execute on function public.area_locking_enabled() to authenticated;

create or replace function public.claim_shared_project_area(
  p_project_id uuid,
  p_area_id uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_claim public.area_claims%rowtype;
begin
  if v_user_id is null then
    raise exception 'Shared areas require an authenticated user.' using errcode = '42501';
  end if;

  if not public.is_active_project_member(p_project_id, v_user_id) then
    raise exception 'You are not an active member of this shared project.' using errcode = '42501';
  end if;

  if not public.area_locking_enabled() then
    -- Compatibility acknowledgement for clients that have not updated yet.
    -- No exclusive claim is created or transferred.
    return jsonb_build_object('id', p_area_id, 'project_id', p_project_id,
      'area_id', p_area_id, 'claimed_by_user_id', v_user_id,
      'status', 'released', 'locking_enabled', false);
  end if;

  select *
    into v_claim
    from public.area_claims
    where project_id = p_project_id
      and area_id = p_area_id
      and status = 'active'
    limit 1;

  if v_claim.id is not null and v_claim.claimed_by_user_id <> v_user_id then
    raise exception 'This area is locked by another user until they release it.' using errcode = '55P03';
  end if;

  if v_claim.id is not null then
    update public.area_claims
      set expires_at = null,
          released_at = null
      where id = v_claim.id
      returning * into v_claim;
  else
    insert into public.area_claims (
      project_id,
      area_id,
      claimed_by_user_id,
      status,
      expires_at
    )
    values (
      p_project_id,
      p_area_id,
      v_user_id,
      'active',
      null
    )
    returning * into v_claim;
  end if;

  return jsonb_build_object(
    'id', v_claim.id,
    'project_id', v_claim.project_id,
    'area_id', v_claim.area_id,
    'claimed_by_user_id', v_claim.claimed_by_user_id,
    'status', v_claim.status,
    'expires_at', v_claim.expires_at
  );
end;
$$;

create or replace function public.claim_shared_project_area_v2(p_project_id uuid, p_area_id uuid, p_device_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_claim public.area_claims%rowtype; v_result jsonb;
begin
  if p_device_id is null or not public.can_edit_project(p_project_id) then
    raise exception 'Sign in on this device before claiming an area.' using errcode = '42501';
  end if;
  if not public.area_locking_enabled() then
    return public.claim_shared_project_area(p_project_id, p_area_id, null)
      || jsonb_build_object('device_id', p_device_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  select * into v_claim from public.area_claims
    where project_id = p_project_id and area_id = p_area_id and status = 'active' for update;
  if found and v_claim.claimed_by_user_id <> auth.uid() then
    raise exception 'This area is locked by another user until they release it.' using errcode = '55P03';
  end if;
  -- The first explicit claim on an upgraded client adopts a legacy user-only claim.
  v_result := public.claim_shared_project_area(p_project_id, p_area_id, null);
  -- Keep the originating device for diagnostics and automatic sync cleanup.
  -- It is not an ownership credential. Explicit release works on any device.
  update public.area_claims set device_id = coalesce(device_id, p_device_id)
    where id = (v_result->>'id')::uuid returning * into v_claim;
  return v_result || jsonb_build_object('device_id', v_claim.device_id);
end;
$$;

create or replace function public.release_shared_project_area_v2(
  p_project_id uuid, p_area_id uuid, p_claim_id uuid, p_device_id uuid, p_expected_version integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_claim public.area_claims%rowtype; v_version integer;
begin
  if auth.uid() is null or p_device_id is null or not public.can_edit_project(p_project_id) then
    raise exception 'Sign in to the claiming account before releasing an area.' using errcode = '42501';
  end if;
  if not public.area_locking_enabled() then return true; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text, 0));
  select * into v_claim from public.area_claims where id = p_claim_id
    and project_id = p_project_id and area_id = p_area_id for update;
  if not found or v_claim.claimed_by_user_id <> auth.uid() then
    raise exception 'The area lock belongs to another account or has changed.' using errcode = '55P03';
  end if;
  if v_claim.status = 'released' then return true; end if;
  if v_claim.status <> 'active' then return false; end if;
  select version into v_version from public.shared_project_area_snapshots
    where project_id = p_project_id and area_id = p_area_id;
  if p_expected_version is null or coalesce(v_version, 0) <> p_expected_version then
    raise exception 'The team area changed. Sync again before releasing it.' using errcode = 'PT409';
  end if;
  update public.area_claims set status = 'released', released_at = now() where id = p_claim_id;
  return true;
end;
$$;

-- Keep the existing version/idempotency guard for simultaneous browser edits.
create or replace function public.publish_shared_project_area_snapshot(
  p_project_id uuid, p_area_id uuid, p_area_payload jsonb, p_payload_version integer default 1,
  p_base_version integer default 0, p_base_published_at timestamptz default null,
  p_client_id text default null, p_device_id uuid default null
) returns table(area_version integer, published_at timestamptz)
language plpgsql security definer set search_path = public set statement_timeout to '60s' as $$
begin
  if p_device_id is null or not public.can_edit_project(p_project_id) then
    raise exception 'Update and sign in on this device before syncing team areas.' using errcode = '42501';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(p_project_id::text, 0)) then
    raise exception 'The project is syncing another change. Retry shortly.' using errcode = 'PT503';
  end if;
  if public.area_locking_enabled() and exists(select 1 from public.area_claims where project_id = p_project_id and area_id = p_area_id
    and status = 'active' and claimed_by_user_id <> auth.uid()) then
    raise exception 'This area is locked by another user.' using errcode = '55P03';
  end if;
  if public.area_locking_enabled() then
    perform public.claim_shared_project_area_v2(p_project_id, p_area_id, p_device_id);
  end if;
  return query select * from public.publish_shared_project_area_snapshot_internal(
    p_project_id, p_area_id, p_area_payload, p_payload_version, p_base_version, p_base_published_at, p_client_id);
end;
$$;



-- Preserve the complete internal publish implementation and all conflict guards.
-- Gate only its exclusive-claim check; fail rather than silently miss the change.
do $migration$
declare
  definition text;
  original text := E'  if exists (\n    select 1\n    from public.area_claims';
begin
  definition := pg_get_functiondef('public.publish_shared_project_area_snapshot_internal(uuid,uuid,jsonb,integer,integer,timestamptz,text)'::regprocedure);
  if position(original in definition) = 0 then
    raise exception 'Expected internal area claim check was not found';
  end if;
  execute replace(definition, original, E'  if public.area_locking_enabled() and exists (\n    select 1\n    from public.area_claims');
end;
$migration$;

-- Keep lock history. Pausing never deletes inspection records or pending device work.
update public.area_claims set status = 'released', released_at = now()
where status = 'active';

notify pgrst, 'reload schema';
