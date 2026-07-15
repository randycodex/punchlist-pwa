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
  v_email text := public.normalize_collaboration_email(p_owner_email);
  v_current_email text := public.current_user_email();
  v_display_name text := nullif(trim(coalesce(p_owner_display_name, '')), '');
  v_project_id uuid;
  v_user_member_id uuid;
  v_email_member_id uuid;
  v_email_member_user_id uuid;
  v_member_id uuid;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if v_email = '' or v_email <> v_current_email then
    raise exception 'Your signed-in account does not match the shared-project email.' using errcode = '42501';
  end if;

  if not public.is_allowed_collaboration_email(v_email) then
    raise exception 'Shared projects require an allowed email address.' using errcode = '42501';
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

  select pm.id
    into v_user_member_id
    from public.project_members pm
    where pm.project_id = v_project_id
      and pm.user_id = v_user_id
      and pm.access_state <> 'removed'
    limit 1
    for update;

  select pm.id, pm.user_id
    into v_email_member_id, v_email_member_user_id
    from public.project_members pm
    where pm.project_id = v_project_id
      and public.normalize_collaboration_email(pm.email) = v_email
      and pm.access_state <> 'removed'
    limit 1
    for update;

  if v_user_member_id is not null
    and v_email_member_id is not null
    and v_user_member_id <> v_email_member_id then
    raise exception 'This email is already linked to another shared-project account.' using errcode = '42501';
  end if;

  if v_email_member_id is not null
    and v_email_member_user_id is distinct from v_user_id then
    raise exception 'This email is already linked to another shared-project account.' using errcode = '42501';
  end if;

  v_member_id := coalesce(v_user_member_id, v_email_member_id);

  if v_member_id is null then
    select pm.id
      into v_member_id
      from public.project_members pm
      where pm.project_id = v_project_id
        and pm.access_state = 'removed'
        and (
          pm.user_id = v_user_id
          or public.normalize_collaboration_email(pm.email) = v_email
        )
      order by
        case when pm.user_id = v_user_id then 0 else 1 end,
        pm.removed_at desc nulls last,
        pm.updated_at desc
      limit 1
      for update;
  end if;

  if v_member_id is null then
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
  else
    update public.project_members
      set user_id = v_user_id,
          email = v_email,
          display_name = coalesce(v_display_name, display_name),
          access_state = 'active',
          joined_by = 'emailInvite',
          joined_at = coalesce(joined_at, now()),
          removed_at = null
      where id = v_member_id;
  end if;

  return v_project_id;
end;
$$;

grant execute on function public.create_shared_project(uuid, text, text, text) to authenticated;

create or replace function public.join_shared_project_by_code(
  p_join_code text,
  p_member_email text,
  p_member_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := public.normalize_collaboration_email(p_member_email);
  v_current_email text := public.current_user_email();
  v_display_name text := nullif(trim(coalesce(p_member_display_name, '')), '');
  v_code_hash text := encode(extensions.digest(upper(regexp_replace(coalesce(p_join_code, ''), '[[:space:]]+', '', 'g')), 'sha256'), 'hex');
  v_project public.shared_projects%rowtype;
  v_user_member_id uuid;
  v_email_member_id uuid;
  v_email_member_user_id uuid;
  v_member_id uuid;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if v_email = '' or v_email <> v_current_email then
    raise exception 'Your signed-in account does not match the shared-project email.' using errcode = '42501';
  end if;

  if not public.is_allowed_collaboration_email(v_email) then
    raise exception 'Shared projects require an allowed email address.' using errcode = '42501';
  end if;

  select *
    into v_project
    from public.shared_projects
    where join_code_hash = v_code_hash
      and join_code_expires_at > now()
      and archived_at is null
    limit 1;

  if v_project.id is null then
    raise exception 'This shared project code is invalid or expired.' using errcode = '22023';
  end if;

  select pm.id
    into v_user_member_id
    from public.project_members pm
    where pm.project_id = v_project.id
      and pm.user_id = v_user_id
      and pm.access_state <> 'removed'
    limit 1
    for update;

  select pm.id, pm.user_id
    into v_email_member_id, v_email_member_user_id
    from public.project_members pm
    where pm.project_id = v_project.id
      and public.normalize_collaboration_email(pm.email) = v_email
      and pm.access_state <> 'removed'
    limit 1
    for update;

  if v_user_member_id is not null
    and v_email_member_id is not null
    and v_user_member_id <> v_email_member_id then
    raise exception 'This email is already linked to another shared-project account.' using errcode = '42501';
  end if;

  if v_email_member_id is not null
    and v_email_member_user_id is distinct from v_user_id then
    raise exception 'This email is already linked to another shared-project account.' using errcode = '42501';
  end if;

  v_member_id := coalesce(v_user_member_id, v_email_member_id);

  if v_member_id is null then
    select pm.id
      into v_member_id
      from public.project_members pm
      where pm.project_id = v_project.id
        and pm.access_state = 'removed'
        and (
          pm.user_id = v_user_id
          or public.normalize_collaboration_email(pm.email) = v_email
        )
      order by
        case when pm.user_id = v_user_id then 0 else 1 end,
        pm.removed_at desc nulls last,
        pm.updated_at desc
      limit 1
      for update;
  end if;

  if v_member_id is null then
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
      v_project.id,
      v_user_id,
      v_email,
      v_display_name,
      'active',
      'joinCode',
      now()
    );
  else
    update public.project_members
      set user_id = v_user_id,
          email = v_email,
          display_name = coalesce(v_display_name, display_name),
          access_state = 'active',
          joined_by = 'joinCode',
          joined_at = coalesce(joined_at, now()),
          removed_at = null
      where id = v_member_id;
  end if;

  return jsonb_build_object(
    'shared_project_id', v_project.id,
    'project_name', v_project.project_name
  );
end;
$$;

grant execute on function public.join_shared_project_by_code(text, text, text) to authenticated;

notify pgrst, 'reload schema';
