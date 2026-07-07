create table if not exists public.collaboration_email_allowlist (
  email text primary key,
  note text,
  created_at timestamptz not null default now(),
  constraint collaboration_email_allowlist_email_check check (position('@' in email) > 1)
);

alter table public.collaboration_email_allowlist enable row level security;

create or replace function public.is_allowed_collaboration_email(email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(trim(coalesce(email, ''))) ~ '^[^@]+@uai-ny\.com$'
    or exists (
      select 1
      from public.collaboration_email_allowlist allowlist
      where lower(allowlist.email) = lower(trim(coalesce(email, '')))
    );
$$;

grant execute on function public.is_allowed_collaboration_email(text) to authenticated;

create or replace function public.is_uai_email(email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_allowed_collaboration_email(email);
$$;

alter table public.project_members
  drop constraint if exists project_members_uai_email_check;

alter table public.project_members
  drop constraint if exists project_members_allowed_email_check;

alter table public.project_members
  add constraint project_members_allowed_email_check
  check (public.is_allowed_collaboration_email(email));

drop policy if exists "uai users can create owned shared projects" on public.shared_projects;
drop policy if exists "allowed users can create owned shared projects" on public.shared_projects;
create policy "allowed users can create owned shared projects"
  on public.shared_projects for insert
  with check (
    auth.uid() is not null
    and owner_user_id = auth.uid()
    and created_by_user_id = auth.uid()
    and public.is_allowed_collaboration_email(public.current_user_email())
  );

drop policy if exists "project members can invite uai members" on public.project_members;
drop policy if exists "project members can invite allowed members" on public.project_members;
create policy "project members can invite allowed members"
  on public.project_members for insert
  with check (
    public.can_edit_project(project_id)
    and public.is_allowed_collaboration_email(email)
  );

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
  v_email text := lower(trim(coalesce(p_member_email, '')));
  v_display_name text := nullif(trim(coalesce(p_member_display_name, '')), '');
  v_code_hash text := encode(extensions.digest(upper(regexp_replace(coalesce(p_join_code, ''), '[[:space:]]+', '', 'g')), 'sha256'), 'hex');
  v_project public.shared_projects%rowtype;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
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

create or replace function public.transfer_shared_project_ownership(
  p_project_id uuid,
  p_new_owner_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text := lower(trim(coalesce(p_new_owner_email, '')));
  v_project public.shared_projects%rowtype;
  v_member public.project_members%rowtype;
begin
  if v_user_id is null then
    raise exception 'Shared projects require an authenticated user.' using errcode = '42501';
  end if;

  if not public.is_allowed_collaboration_email(v_email) then
    raise exception 'Ownership transfer requires an allowed email address.' using errcode = '42501';
  end if;

  select *
    into v_project
    from public.shared_projects
    where id = p_project_id
      and archived_at is null
    limit 1;

  if v_project.id is null then
    raise exception 'Shared project was not found.' using errcode = '22023';
  end if;

  if v_project.owner_user_id <> v_user_id then
    raise exception 'Only the current owner can transfer ownership.' using errcode = '42501';
  end if;

  select *
    into v_member
    from public.project_members
    where project_id = p_project_id
      and lower(email) = v_email
      and access_state = 'active'
      and user_id is not null
    limit 1;

  if v_member.id is null then
    raise exception 'The new owner must join this shared project before ownership can be transferred.' using errcode = '22023';
  end if;

  if v_member.user_id = v_user_id then
    raise exception 'Choose another active project member as the new owner.' using errcode = '22023';
  end if;

  update public.shared_projects
    set owner_user_id = v_member.user_id,
        updated_at = now()
    where id = p_project_id;

  insert into public.ownership_transfers (
    project_id,
    from_user_id,
    to_user_id
  )
  values (
    p_project_id,
    v_user_id,
    v_member.user_id
  );

  return jsonb_build_object(
    'project_id', p_project_id,
    'owner_user_id', v_member.user_id,
    'owner_email', v_member.email
  );
end;
$$;

grant execute on function public.transfer_shared_project_ownership(uuid, text) to authenticated;

notify pgrst, 'reload schema';
