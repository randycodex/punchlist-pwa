create or replace function public.create_shared_project(
  p_local_project_id uuid,
  p_project_name text,
  p_owner_email text,
  p_owner_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_owner_email, '')));
  v_display_name text := nullif(trim(coalesce(p_owner_display_name, '')), '');
  v_project_id uuid;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if not public.is_uai_email(v_email) then
    raise exception 'Shared projects require a UAI email address.' using errcode = '42501';
  end if;

  select sp.id
    into v_project_id
    from public.shared_projects sp
    where sp.local_project_id = p_local_project_id
      and sp.owner_user_id = v_user_id
      and sp.archived_at is null
    limit 1;

  if v_project_id is null then
    insert into public.shared_projects (
      local_project_id,
      project_name,
      owner_user_id,
      created_by_user_id
    )
    values (
      p_local_project_id,
      p_project_name,
      v_user_id,
      v_user_id
    )
    returning id into v_project_id;
  end if;

  begin
    insert into public.project_members (
      project_id,
      user_id,
      email,
      display_name,
      access_state,
      joined_by,
      joined_at
    )
    values (
      v_project_id,
      v_user_id,
      v_email,
      v_display_name,
      'active',
      'emailInvite',
      now()
    );
  exception
    when unique_violation then
      update public.project_members
        set user_id = v_user_id,
            email = v_email,
            display_name = coalesce(v_display_name, display_name),
            access_state = 'active',
            joined_at = coalesce(joined_at, now()),
            removed_at = null
        where project_id = v_project_id
          and lower(email) = v_email;
  end;

  return v_project_id;
end;
$$;

grant execute on function public.create_shared_project(uuid, text, text, text) to authenticated;
