create table if not exists public.shared_project_snapshots (
  project_id uuid primary key references public.shared_projects(id) on delete cascade,
  project_payload jsonb not null,
  payload_version integer not null default 1,
  published_by_user_id uuid not null references auth.users(id) on delete restrict,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.shared_project_snapshots enable row level security;

create policy "project members can read shared project snapshots"
  on public.shared_project_snapshots for select
  using (public.can_access_project(project_id));

create policy "project members can publish shared project snapshots"
  on public.shared_project_snapshots for insert
  with check (
    public.can_edit_project(project_id)
    and published_by_user_id = auth.uid()
  );

create policy "project members can update shared project snapshots"
  on public.shared_project_snapshots for update
  using (public.can_edit_project(project_id))
  with check (
    public.can_edit_project(project_id)
    and published_by_user_id = auth.uid()
  );

create trigger shared_project_snapshots_set_updated_at
  before update on public.shared_project_snapshots
  for each row execute function public.set_updated_at();

grant select, insert, update
  on public.shared_project_snapshots
  to authenticated;

notify pgrst, 'reload schema';
