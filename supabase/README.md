# Supabase

This folder contains source-controlled database setup for collaboration mode.

Apply migrations to the Supabase `punchlist` project after review. The first migration creates the shared-project foundation:

- UAI-only email helper functions
- shared projects with transferable ownership
- project members and invites
- ownership transfer audit records
- area claims for field-work coordination
- mutation audit/queue records
- attachment metadata for shared storage
- Row Level Security policies for project members

The app still needs the Supabase client package and API wiring before these tables are used at runtime.
