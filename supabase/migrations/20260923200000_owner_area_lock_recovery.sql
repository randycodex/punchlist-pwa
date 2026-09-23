-- Owner recovery is restricted to this RPC, which checks the exact claim ID.
-- Keep the existing area_claims row policy unchanged.

create or replace function public.release_abandoned_shared_project_area(
  p_project_id uuid,
  p_area_id uuid,
  p_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.shared_projects sp
    where sp.id = p_project_id
      and sp.owner_user_id = auth.uid()
      and sp.archived_at is null
  ) then
    raise exception 'Only the active project owner can recover an area lock.' using errcode = '42501';
  end if;

  update public.area_claims
    set status = 'released', released_at = now()
    where id = p_claim_id
      and project_id = p_project_id
      and area_id = p_area_id
      and status = 'active'
      and claimed_by_user_id <> auth.uid();
  return found;
end;
$$;

revoke all on function public.release_abandoned_shared_project_area(uuid, uuid, uuid) from public;
grant execute on function public.release_abandoned_shared_project_area(uuid, uuid, uuid) to authenticated;
notify pgrst, 'reload schema';
