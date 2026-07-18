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
  -- Keep the legacy argument until older deployed clients have rolled off.
  -- Area claims intentionally remain active until an explicit release.
  perform p_expires_at;

  if v_user_id is null then
    raise exception 'Shared areas require an authenticated user.' using errcode = '42501';
  end if;

  if not public.is_active_project_member(p_project_id, v_user_id) then
    raise exception 'You are not an active member of this shared project.' using errcode = '42501';
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

grant execute on function public.claim_shared_project_area(uuid, uuid, timestamptz) to authenticated;

notify pgrst, 'reload schema';
