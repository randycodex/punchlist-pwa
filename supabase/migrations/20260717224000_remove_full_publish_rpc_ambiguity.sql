-- PostgREST resolves overloads before applying execute privileges, so keeping
-- the guarded four-argument route beside the five-argument implementation can
-- still produce PGRST203. Give the implementation an internal name and leave
-- exactly one public signature per REST endpoint.

alter function public.publish_shared_project_snapshot(
  uuid, jsonb, integer, timestamptz, integer
) rename to publish_shared_project_snapshot_versioned;

revoke execute on function public.publish_shared_project_snapshot_versioned(
  uuid, jsonb, integer, timestamptz, integer
) from public, anon, authenticated;

create or replace function public.publish_shared_project_snapshot_v2(
  p_project_id uuid,
  p_project_payload jsonb,
  p_payload_version integer,
  p_base_published_at timestamptz,
  p_base_metadata_version integer
)
returns timestamptz
language sql
security definer
set search_path = public
set statement_timeout to '60s'
as $$
  select public.publish_shared_project_snapshot_versioned(
    p_project_id,
    p_project_payload,
    p_payload_version,
    p_base_published_at,
    p_base_metadata_version
  );
$$;

grant execute on function public.publish_shared_project_snapshot_v2(
  uuid, jsonb, integer, timestamptz, integer
) to authenticated;

notify pgrst, 'reload schema';
