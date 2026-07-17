-- The five-argument implementation now has an internal name; keep the legacy
-- wrapper pointed at it after the overload-removal rename.

create or replace function public.publish_shared_project_snapshot(
  p_project_id uuid,
  p_project_payload jsonb,
  p_payload_version integer default 1,
  p_base_published_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
set statement_timeout to '60s'
as $$
begin
  if exists (
    select 1
    from public.shared_project_metadata_snapshots
    where project_id = p_project_id
  ) then
    raise exception 'Shared project has newer metadata. Update the app and pull shared data before publishing again.' using errcode = '40001';
  end if;

  return public.publish_shared_project_snapshot_versioned(
    p_project_id,
    p_project_payload,
    p_payload_version,
    p_base_published_at,
    0
  );
end;
$$;

grant execute on function public.publish_shared_project_snapshot(
  uuid, jsonb, integer, timestamptz
) to authenticated;

notify pgrst, 'reload schema';
