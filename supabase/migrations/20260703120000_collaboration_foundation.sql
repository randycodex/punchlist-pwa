create extension if not exists pgcrypto;

create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select lower(
    coalesce(
      nullif(auth.jwt() ->> 'email', ''),
      nullif(auth.jwt() ->> 'preferred_username', ''),
      nullif(auth.jwt() ->> 'upn', '')
    )
  );
$$;

create or replace function public.is_uai_email(email text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(email, '')) like '%@uai-ny.com';
$$;

create or replace function public.try_parse_uuid(value text)
returns uuid
language plpgsql
immutable
as $$
begin
  return value::uuid;
exception
  when others then
    return null;
end;
$$;

create table public.shared_projects (
  id uuid primary key default gen_random_uuid(),
  local_project_id uuid,
  project_name text not null,
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_by_user_id uuid not null references auth.users(id) on delete restrict,
  join_code_hash text,
  join_code_expires_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_projects_owner_created_by_check check (owner_user_id = created_by_user_id or owner_user_id is not null)
);

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  access_state text not null default 'invited',
  joined_by text not null default 'emailInvite',
  invited_by_user_id uuid references auth.users(id) on delete set null,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_members_access_state_check check (access_state in ('invited', 'active', 'removed')),
  constraint project_members_joined_by_check check (joined_by in ('emailInvite', 'joinCode')),
  constraint project_members_uai_email_check check (public.is_uai_email(email)),
  constraint project_members_user_or_invite_check check (user_id is not null or access_state = 'invited')
);

create unique index project_members_active_user_idx
  on public.project_members(project_id, user_id)
  where user_id is not null and access_state <> 'removed';

create unique index project_members_active_email_idx
  on public.project_members(project_id, lower(email))
  where access_state <> 'removed';

create table public.ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  from_user_id uuid not null references auth.users(id) on delete restrict,
  to_user_id uuid not null references auth.users(id) on delete restrict,
  transferred_at timestamptz not null default now()
);

create table public.area_claims (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  area_id uuid not null,
  claimed_by_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active',
  claimed_at timestamptz not null default now(),
  expires_at timestamptz,
  released_at timestamptz,
  transferred_to_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint area_claims_status_check check (status in ('active', 'released', 'transferred', 'expired')),
  constraint area_claims_expiry_check check (expires_at is null or expires_at > claimed_at)
);

create unique index area_claims_one_active_claim_idx
  on public.area_claims(project_id, area_id)
  where status = 'active';

create table public.collaboration_mutations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  parent_entity_id uuid,
  action text not null,
  patch jsonb not null default '{}'::jsonb,
  base_version integer,
  author_user_id uuid not null references auth.users(id) on delete restrict,
  client_id text not null,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  error_message text,
  constraint collaboration_mutations_entity_type_check check (
    entity_type in ('project', 'area', 'location', 'item', 'checkpoint', 'photoAttachment', 'fileAttachment')
  ),
  constraint collaboration_mutations_action_check check (
    action in ('create', 'update', 'delete', 'restore', 'attach', 'detach')
  ),
  constraint collaboration_mutations_status_check check (
    status in ('queued', 'sending', 'accepted', 'rejected', 'conflicted')
  )
);

create index collaboration_mutations_project_created_idx
  on public.collaboration_mutations(project_id, created_at);

create table public.shared_attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.shared_projects(id) on delete cascade,
  area_id uuid,
  checkpoint_id uuid,
  uploaded_by_user_id uuid not null references auth.users(id) on delete restrict,
  storage_bucket text not null,
  storage_path text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shared_attachments_size_check check (size_bytes >= 0)
);

create unique index shared_attachments_storage_path_idx
  on public.shared_attachments(storage_bucket, storage_path);

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
      and pm.user_id = $2
      and pm.access_state = 'active'
  );
$$;

create or replace function public.can_access_project(project_id uuid)
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
      and sp.owner_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.project_members pm
    where pm.project_id = $1
      and pm.access_state <> 'removed'
      and (
        pm.user_id = auth.uid()
        or lower(pm.email) = public.current_user_email()
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
      and sp.owner_user_id = auth.uid()
  )
  or public.is_active_project_member($1, auth.uid());
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table public.shared_projects enable row level security;
alter table public.project_members enable row level security;
alter table public.ownership_transfers enable row level security;
alter table public.area_claims enable row level security;
alter table public.collaboration_mutations enable row level security;
alter table public.shared_attachments enable row level security;

create policy "members can read shared projects"
  on public.shared_projects for select
  using (public.can_access_project(id));

create policy "uai users can create owned shared projects"
  on public.shared_projects for insert
  with check (
    auth.uid() is not null
    and owner_user_id = auth.uid()
    and created_by_user_id = auth.uid()
    and public.is_uai_email(public.current_user_email())
  );

create policy "members can update shared projects"
  on public.shared_projects for update
  using (public.can_edit_project(id))
  with check (public.can_edit_project(id));

create policy "project members can read members"
  on public.project_members for select
  using (public.can_access_project(project_id));

create policy "project members can invite uai members"
  on public.project_members for insert
  with check (
    public.can_edit_project(project_id)
    and public.is_uai_email(email)
  );

create policy "project members can update membership"
  on public.project_members for update
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

create policy "project members can read ownership transfers"
  on public.ownership_transfers for select
  using (public.can_access_project(project_id));

create policy "owners can record ownership transfers"
  on public.ownership_transfers for insert
  with check (
    exists (
      select 1
      from public.shared_projects
      where shared_projects.id = ownership_transfers.project_id
        and shared_projects.owner_user_id = auth.uid()
    )
  );

create policy "project members can read area claims"
  on public.area_claims for select
  using (public.can_access_project(project_id));

create policy "project members can create area claims"
  on public.area_claims for insert
  with check (
    public.is_active_project_member(project_id, auth.uid())
    and claimed_by_user_id = auth.uid()
  );

create policy "claim holders can update area claims"
  on public.area_claims for update
  using (
    claimed_by_user_id = auth.uid()
    or public.can_edit_project(project_id)
  )
  with check (public.can_edit_project(project_id));

create policy "project members can read mutations"
  on public.collaboration_mutations for select
  using (public.can_access_project(project_id));

create policy "project members can create mutations"
  on public.collaboration_mutations for insert
  with check (
    public.is_active_project_member(project_id, auth.uid())
    and author_user_id = auth.uid()
  );

create policy "authors can update pending mutations"
  on public.collaboration_mutations for update
  using (
    author_user_id = auth.uid()
    or public.can_edit_project(project_id)
  )
  with check (public.can_edit_project(project_id));

create policy "project members can read attachments"
  on public.shared_attachments for select
  using (public.can_access_project(project_id));

create policy "project members can create attachments"
  on public.shared_attachments for insert
  with check (
    public.is_active_project_member(project_id, auth.uid())
    and uploaded_by_user_id = auth.uid()
  );

create policy "project members can update attachments"
  on public.shared_attachments for update
  using (public.can_edit_project(project_id))
  with check (public.can_edit_project(project_id));

create trigger shared_projects_set_updated_at
  before update on public.shared_projects
  for each row execute function public.set_updated_at();

create trigger project_members_set_updated_at
  before update on public.project_members
  for each row execute function public.set_updated_at();

create trigger area_claims_set_updated_at
  before update on public.area_claims
  for each row execute function public.set_updated_at();

create trigger shared_attachments_set_updated_at
  before update on public.shared_attachments
  for each row execute function public.set_updated_at();

insert into storage.buckets (id, name, public)
values ('punchlist-attachments', 'punchlist-attachments', false)
on conflict (id) do nothing;

create policy "project members can read attachment files"
  on storage.objects for select
  using (
    bucket_id = 'punchlist-attachments'
    and public.can_access_project(public.try_parse_uuid((storage.foldername(name))[1]))
  );

create policy "project members can upload attachment files"
  on storage.objects for insert
  with check (
    bucket_id = 'punchlist-attachments'
    and public.is_active_project_member(public.try_parse_uuid((storage.foldername(name))[1]), auth.uid())
  );

create policy "project members can update attachment files"
  on storage.objects for update
  using (
    bucket_id = 'punchlist-attachments'
    and public.is_active_project_member(public.try_parse_uuid((storage.foldername(name))[1]), auth.uid())
  )
  with check (
    bucket_id = 'punchlist-attachments'
    and public.is_active_project_member(public.try_parse_uuid((storage.foldername(name))[1]), auth.uid())
  );

create policy "project members can delete attachment files"
  on storage.objects for delete
  using (
    bucket_id = 'punchlist-attachments'
    and public.is_active_project_member(public.try_parse_uuid((storage.foldername(name))[1]), auth.uid())
  );
