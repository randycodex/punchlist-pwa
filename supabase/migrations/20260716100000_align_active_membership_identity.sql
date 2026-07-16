-- Shared-project reads already recognize an active member by either the bound
-- auth user id or the verified account email. Keep edit checks aligned so an
-- older member row cannot allow pulls while rejecting publishes and claims.

create or replace function public.is_active_project_member(project_id uuid, user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_members pm
    where pm.project_id = $1
      and pm.access_state = 'active'
      and (
        pm.user_id = $2
        or (
          $2 = auth.uid()
          and public.normalize_collaboration_email(pm.email) = public.current_user_email()
        )
      )
  );
$$;

create or replace function public.can_edit_project(project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.shared_projects sp
    where sp.id = $1
      and sp.archived_at is null
      and sp.owner_user_id = auth.uid()
  )
  or (
    exists (
      select 1
      from public.shared_projects sp
      where sp.id = $1
        and sp.archived_at is null
    )
    and public.is_active_project_member($1, auth.uid())
  );
$$;

notify pgrst, 'reload schema';
