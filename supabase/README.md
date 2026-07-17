# Supabase

This folder contains source-controlled database setup for collaboration mode.

Apply migrations to the Supabase `punchlist` project after review. The first migration creates the shared-project foundation:

- UAI email helper functions with an optional exact-email test allowlist
- shared projects with transferable ownership
- project members and invites
- ownership transfer audit records
- area claims for field-work coordination
- mutation audit/queue records
- attachment metadata for shared storage
- Row Level Security policies for project members

The app uses the private `punchlist-attachments` bucket for compact version-2
shared snapshots. Photos, files, thumbnails, and facade drawings are uploaded
before the compact JSON snapshot is published; version-1 inline snapshots remain
readable for backward compatibility. Apply migrations through
`20260717160000_compact_shared_snapshot_assets.sql` before relying on the
lightweight backup-list query.

To temporarily allow a non-UAI tester, add the exact lower-case email after applying migrations:

```sql
insert into public.collaboration_email_allowlist (email, note)
values ('tester@gmail.com', 'temporary shared-project test account')
on conflict (email) do update set note = excluded.note;
```

The app must also include the same exact email in `NEXT_PUBLIC_COLLABORATION_ALLOWED_EMAILS`. If the tester uses a personal Microsoft account with a Gmail address, the Microsoft and Supabase Azure OAuth settings may need to allow personal Microsoft accounts, such as using `NEXT_PUBLIC_MS_TENANT_ID=common` locally.
