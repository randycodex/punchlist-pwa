-- Shared projects can contain large photo, file, and elevation payloads. Give
-- this specific REST RPC enough time to write them without weakening the
-- timeout for normal authenticated requests. Preserve the previous published
-- version as the recovery point, but do not duplicate the new live snapshot in
-- history: the live snapshot already is the published version.

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
declare
  v_user_id uuid := auth.uid();
  v_current_published_at timestamptz;
  v_current_payload jsonb;
  v_current_payload_version integer;
  v_next_published_at timestamptz := now();
begin
  if v_user_id is null then
    raise exception 'Shared project publishing requires an authenticated user.' using errcode = '42501';
  end if;

  if not public.can_edit_project(p_project_id) then
    raise exception 'You do not have access to publish this shared project.' using errcode = '42501';
  end if;

  select published_at, project_payload, payload_version
    into v_current_published_at, v_current_payload, v_current_payload_version
    from public.shared_project_snapshots
    where project_id = p_project_id
    for update;

  if found then
    if p_base_published_at is not null
      and v_current_published_at > p_base_published_at + interval '2 seconds'
    then
      raise exception 'Shared project has newer published data. Pull shared data before publishing again.' using errcode = '40001';
    end if;

    insert into public.shared_project_snapshot_history (
      project_id,
      project_payload,
      payload_version,
      captured_by_user_id,
      captured_at,
      reason,
      note
    )
    values (
      p_project_id,
      v_current_payload,
      v_current_payload_version,
      v_user_id,
      v_current_published_at,
      'before_publish',
      'Latest shared data before this publish.'
    );

    update public.shared_project_snapshots
      set project_payload = p_project_payload,
          payload_version = p_payload_version,
          published_by_user_id = v_user_id,
          published_at = v_next_published_at
      where project_id = p_project_id;
  else
    insert into public.shared_project_snapshots (
      project_id,
      project_payload,
      payload_version,
      published_by_user_id,
      published_at
    )
    values (
      p_project_id,
      p_project_payload,
      p_payload_version,
      v_user_id,
      v_next_published_at
    );
  end if;

  return v_next_published_at;
end;
$$;

grant execute on function public.publish_shared_project_snapshot(uuid, jsonb, integer, timestamptz)
  to authenticated;

notify pgrst, 'reload schema';
