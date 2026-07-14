create table public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  first_name text not null,
  last_name text not null,
  job_title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_username_format_check check (
    username = lower(username)
    and username ~ '^[a-z0-9][a-z0-9._-]{2,29}$'
  ),
  constraint user_profiles_first_name_check check (char_length(trim(first_name)) between 1 and 80),
  constraint user_profiles_last_name_check check (char_length(trim(last_name)) between 1 and 80),
  constraint user_profiles_job_title_check check (char_length(trim(job_title)) between 1 and 120)
);

create unique index user_profiles_username_idx
  on public.user_profiles(lower(username));

create or replace function public.can_view_user_profile(profile_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() = profile_user_id
  or exists (
    select 1
    from public.project_members viewer
    join public.project_members subject
      on subject.project_id = viewer.project_id
    where viewer.user_id = auth.uid()
      and viewer.access_state = 'active'
      and subject.user_id = profile_user_id
      and subject.access_state = 'active'
  );
$$;

create or replace function public.sync_user_profile_member_display_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.project_members
  set display_name = concat_ws(' ', trim(new.first_name), trim(new.last_name))
  where user_id = new.user_id
    and display_name is distinct from concat_ws(' ', trim(new.first_name), trim(new.last_name));
  return new;
end;
$$;

create or replace function public.apply_user_profile_to_project_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_display_name text;
begin
  if new.user_id is null then
    return new;
  end if;

  select concat_ws(' ', trim(first_name), trim(last_name))
  into profile_display_name
  from public.user_profiles
  where user_id = new.user_id;

  if profile_display_name is not null then
    new.display_name = profile_display_name;
  end if;
  return new;
end;
$$;

alter table public.user_profiles enable row level security;

create policy "users can read relevant profiles"
  on public.user_profiles for select
  using (public.can_view_user_profile(user_id));

create policy "users can create their profile"
  on public.user_profiles for insert
  with check (user_id = auth.uid());

create policy "users can update their profile"
  on public.user_profiles for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create trigger user_profiles_set_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

create trigger user_profiles_sync_member_display_name
  after insert or update of first_name, last_name on public.user_profiles
  for each row execute function public.sync_user_profile_member_display_name();

create trigger project_members_apply_user_profile
  before insert or update of user_id on public.project_members
  for each row execute function public.apply_user_profile_to_project_member();

grant select, insert, update on public.user_profiles to authenticated;
