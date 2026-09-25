-- New clients write content-hashed immutable paths. Keep prior objects readable
-- for current snapshots and backups; object lifecycle deletion is server-only.
drop policy if exists "project members can update attachment files" on storage.objects;
drop policy if exists "project members can delete attachment files" on storage.objects;

-- New metadata must agree with its storage namespace. NOT VALID preserves any
-- legacy rows for review while enforcing the constraint on new/updated records.
alter table public.shared_attachments add constraint shared_attachment_project_path
  check (storage_bucket = 'punchlist-attachments' and split_part(storage_path, '/', 1) = project_id::text) not valid;

revoke update, delete on public.shared_attachments from anon, authenticated;

-- An owner can inspect old unreferenced metadata without deleting anything.
-- Both current state and historical backups protect their referenced objects.
create function public.list_unreferenced_shared_attachments(p_project_id uuid)
returns table(storage_bucket text, storage_path text, size_bytes bigint)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not exists(select 1 from public.shared_projects where id = p_project_id and owner_user_id = auth.uid()) then
    raise exception 'Only the project owner can inspect attachment cleanup candidates.' using errcode = '42501';
  end if;
  return query
  with payloads as (
    select project_payload as payload, payload_version from public.shared_project_snapshots where project_id = p_project_id
    union all
    select area_payload, payload_version from public.shared_project_area_snapshots where project_id = p_project_id
    union all
    select project_payload, payload_version from public.shared_project_snapshot_history where project_id = p_project_id
  ), referenced as (
    select jsonb_path_query(payload, '$.assets.**.path') as path from payloads where payload_version = 2
  )
  select attachment.storage_bucket, attachment.storage_path, attachment.size_bytes
  from public.shared_attachments attachment
  where attachment.project_id = p_project_id
    and attachment.updated_at < now() - interval '7 days'
    and not exists(select 1 from payloads where payload_version not in (1, 2))
    and not exists(select 1 from referenced where path = to_jsonb(attachment.storage_path));
end;
$$;
revoke all on function public.list_unreferenced_shared_attachments(uuid) from public, anon;
grant execute on function public.list_unreferenced_shared_attachments(uuid) to authenticated;
notify pgrst, 'reload schema';
