create or replace function public.can_access_project(project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shared_projects sp
    where sp.id = $1
      and sp.archived_at is null
      and sp.owner_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.shared_projects sp
    join public.project_members pm
      on pm.project_id = sp.id
    where sp.id = $1
      and sp.archived_at is null
      and pm.access_state <> 'removed'
      and (
        pm.user_id = auth.uid()
        or lower(pm.email) = public.current_user_email()
      )
  );
$$;

create or replace function public.can_edit_project(project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shared_projects sp
    where sp.id = $1
      and sp.archived_at is null
      and sp.owner_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.shared_projects sp
    join public.project_members pm
      on pm.project_id = sp.id
    where sp.id = $1
      and sp.archived_at is null
      and pm.user_id = auth.uid()
      and pm.access_state = 'active'
  );
$$;

create or replace function public.disconnect_shared_project(p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := public.current_user_email();
  v_project public.shared_projects%rowtype;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
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

  if v_project.owner_user_id = v_user_id then
    update public.shared_projects
      set archived_at = now(),
          join_code_hash = null,
          join_code_expires_at = null
      where id = p_project_id;

    update public.project_members
      set access_state = 'removed',
          removed_at = coalesce(removed_at, now())
      where project_id = p_project_id
        and access_state <> 'removed';

    update public.area_claims
      set status = 'expired',
          released_at = coalesce(released_at, now())
      where project_id = p_project_id
        and status = 'active';

    return jsonb_build_object(
      'action', 'archived',
      'project_id', p_project_id
    );
  end if;

  update public.project_members
    set access_state = 'removed',
        removed_at = coalesce(removed_at, now())
    where project_id = p_project_id
      and access_state <> 'removed'
      and (
        user_id = v_user_id
        or lower(email) = v_email
      );

  if not found then
    raise exception 'You are not an active member of this shared project.' using errcode = '42501';
  end if;

  update public.area_claims
    set status = 'released',
        released_at = coalesce(released_at, now())
    where project_id = p_project_id
      and status = 'active'
      and claimed_by_user_id = v_user_id;

  return jsonb_build_object(
    'action', 'left',
    'project_id', p_project_id
  );
end;
$$;

grant execute on function public.disconnect_shared_project(uuid) to authenticated;

notify pgrst, 'reload schema';
