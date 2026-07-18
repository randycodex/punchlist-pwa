create or replace function public.remove_shared_project_member(
  p_project_id uuid,
  p_member_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_member_email, '')));
  v_project public.shared_projects%rowtype;
  v_member public.project_members%rowtype;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if v_email = '' then
    raise exception 'Choose a project member to remove.' using errcode = '22023';
  end if;

  select *
    into v_project
    from public.shared_projects
    where id = p_project_id
      and archived_at is null
    for update;

  if v_project.id is null then
    raise exception 'This shared project is not active.' using errcode = '22023';
  end if;

  if v_project.owner_user_id <> v_user_id then
    raise exception 'Only the project owner can remove members.' using errcode = '42501';
  end if;

  select *
    into v_member
    from public.project_members
    where project_id = p_project_id
      and lower(email) = v_email
      and access_state <> 'removed'
    limit 1
    for update;

  if v_member.id is null then
    raise exception 'This member is no longer active in the shared project.' using errcode = '22023';
  end if;

  if v_member.user_id = v_project.owner_user_id then
    raise exception 'Transfer ownership before removing the project owner.' using errcode = '22023';
  end if;

  update public.project_members
    set access_state = 'removed',
        removed_at = now()
    where id = v_member.id;

  if v_member.user_id is not null then
    update public.area_claims
      set status = 'released',
          released_at = coalesce(released_at, now())
      where project_id = p_project_id
        and claimed_by_user_id = v_member.user_id
        and status = 'active';
  end if;

  update public.shared_projects
    set join_code_hash = null,
        join_code_expires_at = null,
        updated_at = now()
    where id = p_project_id;

  return jsonb_build_object(
    'project_id', p_project_id,
    'member_email', v_member.email,
    'invite_invalidated', true
  );
end;
$$;

grant execute on function public.remove_shared_project_member(uuid, text) to authenticated;

notify pgrst, 'reload schema';
