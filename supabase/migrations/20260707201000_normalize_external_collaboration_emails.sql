create or replace function public.normalize_collaboration_email(value text)
returns text
language plpgsql
immutable
as $$
declare
  v_email text := lower(trim(coalesce(value, '')));
  v_ext_marker integer;
  v_encoded_email text;
  v_domain_separator integer;
begin
  if v_email = '' then
    return '';
  end if;

  v_ext_marker := strpos(v_email, '#ext#@');
  if v_ext_marker > 0 then
    v_encoded_email := substring(v_email from 1 for v_ext_marker - 1);
    v_domain_separator := length(v_encoded_email) - strpos(reverse(v_encoded_email), '_') + 1;

    if v_domain_separator > 1 and v_domain_separator < length(v_encoded_email) then
      return substring(v_encoded_email from 1 for v_domain_separator - 1)
        || '@'
        || substring(v_encoded_email from v_domain_separator + 1);
    end if;
  end if;

  return v_email;
end;
$$;

grant execute on function public.normalize_collaboration_email(text) to authenticated;

create or replace function public.current_user_email()
returns text
language sql
stable
as $$
  select public.normalize_collaboration_email(
    coalesce(
      nullif(auth.jwt() ->> 'email', ''),
      nullif(auth.jwt() ->> 'preferred_username', ''),
      nullif(auth.jwt() ->> 'upn', '')
    )
  );
$$;

create or replace function public.is_allowed_collaboration_email(email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.normalize_collaboration_email(email) ~ '^[^@]+@uai-ny\.com$'
    or exists (
      select 1
      from public.collaboration_email_allowlist allowlist
      where lower(allowlist.email) = public.normalize_collaboration_email(email)
    );
$$;

create or replace function public.is_uai_email(email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_allowed_collaboration_email(email);
$$;

notify pgrst, 'reload schema';
