drop function if exists public.list_my_shared_projects();

create function public.list_my_shared_projects()
returns table (
  project_id uuid,
  local_project_id uuid,
  project_name text,
  owner_user_id uuid,
  owner_email text,
  joined_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    sp.id as project_id,
    sp.local_project_id,
    sp.project_name,
    sp.owner_user_id,
    owner_member.email as owner_email,
    pm.joined_at,
    greatest(sps.published_at, area_updates.published_at, metadata_updates.published_at) as published_at,
    sp.updated_at
  from public.project_members pm
  join public.shared_projects sp
    on sp.id = pm.project_id
  left join public.project_members owner_member
    on owner_member.project_id = sp.id
    and owner_member.user_id = sp.owner_user_id
    and owner_member.access_state <> 'removed'
  left join public.shared_project_snapshots sps
    on sps.project_id = sp.id
  left join lateral (
    select max(sas.published_at) as published_at
    from public.shared_project_area_snapshots sas
    where sas.project_id = sp.id
  ) area_updates on true
  left join public.shared_project_metadata_snapshots metadata_updates
    on metadata_updates.project_id = sp.id
  where auth.uid() is not null
    and pm.access_state = 'active'
    and sp.archived_at is null
    and (
      pm.user_id = auth.uid()
      or public.normalize_collaboration_email(pm.email) = public.current_user_email()
    )
  order by coalesce(
      greatest(sps.published_at, area_updates.published_at, metadata_updates.published_at),
      sp.updated_at
    ) desc,
    sp.project_name asc;
$$;

grant execute on function public.list_my_shared_projects() to authenticated;

notify pgrst, 'reload schema';
