-- Area locks belong to the authenticated account across browsers and devices.
-- Preserve claim identity, membership checks, and accepted-version checks.
create or replace function public.claim_shared_project_area_v2(p_project_id uuid, p_area_id uuid, p_device_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_claim public.area_claims%rowtype; v_result jsonb;
begin
  if p_device_id is null or not public.can_edit_project(p_project_id) then
    raise exception 'Sign in on this device before claiming an area.' using errcode = '42501';
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
  if exists(select 1 from public.area_claims where project_id = p_project_id and area_id = p_area_id
    and status = 'active' and claimed_by_user_id <> auth.uid()) then
    raise exception 'This area is locked by another user.' using errcode = '55P03';
  end if;
  perform public.claim_shared_project_area_v2(p_project_id, p_area_id, p_device_id);
  return query select * from public.publish_shared_project_area_snapshot_internal(
    p_project_id, p_area_id, p_area_payload, p_payload_version, p_base_version, p_base_published_at, p_client_id);
end;
$$;


notify pgrst, 'reload schema';
