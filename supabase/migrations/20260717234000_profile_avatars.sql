alter table public.user_profiles
  add column avatar_path text,
  add column avatar_synced_at timestamptz;

alter table public.user_profiles
  add constraint user_profiles_avatar_path_check check (
    avatar_path is null
    or avatar_path = user_id::text || '/microsoft-profile'
  );

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'punchlist-avatars',
  'punchlist-avatars',
  false,
  2097152,
  array['image/jpeg', 'image/png']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_view_profile_avatar_object(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.user_id::text = split_part(object_name, '/', 1)
      and public.can_view_user_profile(profile.user_id)
  );
$$;

create policy "relevant members can read profile avatars"
  on storage.objects for select
  using (
    bucket_id = 'punchlist-avatars'
    and public.can_view_profile_avatar_object(name)
  );

create policy "users can upload their profile avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'punchlist-avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "users can update their profile avatar"
  on storage.objects for update
  using (
    bucket_id = 'punchlist-avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  )
  with check (
    bucket_id = 'punchlist-avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );

create policy "users can delete their profile avatar"
  on storage.objects for delete
  using (
    bucket_id = 'punchlist-avatars'
    and split_part(name, '/', 1) = auth.uid()::text
  );
