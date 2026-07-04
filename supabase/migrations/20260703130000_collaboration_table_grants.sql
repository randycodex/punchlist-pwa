grant usage on schema public to authenticated;

grant select, insert, update
  on public.shared_projects,
     public.project_members,
     public.area_claims,
     public.collaboration_mutations,
     public.shared_attachments
  to authenticated;

grant select, insert
  on public.ownership_transfers
  to authenticated;

grant usage on schema storage to authenticated;

grant select, insert, update, delete
  on storage.objects
  to authenticated;
