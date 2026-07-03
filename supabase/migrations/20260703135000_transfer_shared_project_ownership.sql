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

  if not public.is_uai_email(v_email) then
    raise exception 'Ownership transfer requires a UAI email address.' using errcode = '42501';
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
