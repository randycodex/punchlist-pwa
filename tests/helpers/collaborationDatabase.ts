import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readdir, readFile } from 'node:fs/promises';

/** Real PostgreSQL semantics with a minimal local Supabase auth/storage surface. */
export async function createCollaborationTestDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object('email', current_setting('request.jwt.claim.email', true)) $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on all functions in schema auth to authenticated, anon;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  `);
  for (const name of (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    try { await db.exec(await readFile(`supabase/migrations/${name}`, 'utf8')); }
    catch (error) { await db.close(); throw new Error(`Migration ${name} failed`, { cause: error }); }
  }
  return db;
}
