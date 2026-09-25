-- Clients read these records, but only the authorization/version-checking RPCs
-- may mutate them. RLS alone previously allowed members to bypass those RPCs.
revoke insert, update, delete on
  public.shared_projects,
  public.project_members,
  public.area_claims,
  public.collaboration_mutations,
  public.ownership_transfers,
  public.shared_project_snapshots,
  public.shared_project_area_snapshots,
  public.shared_project_metadata_snapshots,
  public.shared_project_snapshot_history
from anon, authenticated;

-- SECURITY DEFINER routines are not public APIs unless explicitly granted.
-- Preserve authenticated grants on the public RPCs and the existing private
-- versioned implementation's revoked grant.
do $$
declare routine record;
begin
  for routine in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon', routine.signature);
  end loop;
end;
$$;

-- RLS helper functions must remain usable while evaluating authenticated reads.
grant execute on function public.can_access_project(uuid),
  public.can_edit_project(uuid), public.is_active_project_member(uuid, uuid),
  public.can_view_user_profile(uuid), public.can_view_profile_avatar_object(text),
  public.current_user_email()
to authenticated;

notify pgrst, 'reload schema';
