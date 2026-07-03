create or replace function public.generate_shared_project_join_code(p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_expires_at timestamptz := now() + interval '7 days';
begin
  if auth.uid() is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to invite users to this project.' using errcode = '42501';
  end if;

  v_code := upper(substring(encode(gen_random_bytes(6), 'hex') from 1 for 10));

  update public.shared_projects
    set join_code_hash = encode(digest(v_code, 'sha256'), 'hex'),
        join_code_expires_at = v_expires_at
    where id = p_project_id;

  return jsonb_build_object(
    'join_code', v_code,
    'expires_at', v_expires_at
  );
end;
$$;

grant execute on function public.generate_shared_project_join_code(uuid) to authenticated;

create or replace function public.join_shared_project_by_code(
  p_join_code text,
  p_member_email text,
  p_member_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_member_email, '')));
  v_display_name text := nullif(trim(coalesce(p_member_display_name, '')), '');
  v_code_hash text := encode(digest(upper(regexp_replace(coalesce(p_join_code, ''), '[[:space:]]+', '', 'g')), 'sha256'), 'hex');
  v_project public.shared_projects%rowtype;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if not public.is_uai_email(v_email) then
    raise exception 'Shared projects require a UAI email address.' using errcode = '42501';
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
      v_project.id,
      v_user_id,
      v_email,
      v_display_name,
      'active',
      'joinCode',
      now()
    );
  exception
    when unique_violation then
      update public.project_members
        set user_id = v_user_id,
            email = v_email,
            display_name = coalesce(v_display_name, display_name),
            access_state = 'active',
            joined_by = 'joinCode',
            joined_at = coalesce(joined_at, now()),
            removed_at = null
        where project_id = v_project.id
          and (user_id = v_user_id or lower(email) = v_email);
  end;

  return jsonb_build_object(
    'shared_project_id', v_project.id,
    'project_name', v_project.project_name
  );
end;
$$;

grant execute on function public.join_shared_project_by_code(text, text, text) to authenticated;
