# Attachment limits and read-only inventory

New shared attachment uploads are limited to **26,214,400 bytes (25 MiB)**,
matching the existing photo source and elevation picker cap. Photo payloads
allow `image/*`; elevation drawings allow `application/pdf`, `image/jpeg`,
`image/png`, `image/webp`. Generic checkpoint files from imported backups keep
valid MIME types (including `application/octet-stream`); narrowing these to PDF
would break supported imported projects. Empty uploads are rejected. Validation
happens during planning before any upload; existing immutable metadata references
can still be reused and downloaded, including historical out-of-policy objects.
App validation is a usability guard, not server enforcement or content sniffing.

Run `scripts/storage-inventory.sql` with an authorized read-only database session.
It uses a read-only transaction and a 15-second statement timeout, reports bucket
settings, aggregate MIME/byte counts, oversized objects, unknown size metadata,
30 daily creation cohorts, and application metadata totals. It returns no file
names or private attachment contents. Storage metadata rows are not the bytes:
this report does not verify object readability, identify safe deletion candidates,
or measure historical net growth. Repeat inventory snapshots to track changes.
A statement timeout should prompt a narrower query, not a higher production limit.

## Proposed server settings — approval required, not applied

For the existing private `punchlist-attachments` bucket:

- `public: false` (keep current privacy)
- `fileSizeLimit: 26214400`
- `allowedMimeTypes: null` until the generic-file inventory and supported import
  formats justify an explicit allowlist. An `image/*` + PDF allowlist alone is
  incompatible with existing generic checkpoint files.

A bucket update with these exact settings must be approved separately. First
review the inventory for oversized/unusual historical files and confirm that
supported restore/import workflows handle validation errors. Existing bytes must
remain readable; no delete, overwrite, policy, scope or retention change is needed.
The browser upload stays `upsert: false`, with duplicate-object hash/size verification.

Supabase documents `fileSizeLimit` and `allowedMimeTypes` in its
[upload restriction guide](https://supabase.com/docs/guides/storage/buckets/creating-buckets).
October 3, 2026 read-only hosted aggregate inventory found 9,037 attachment
objects: 9,033 JPEGs (455,734,345 declared bytes) and 4 PNGs (6,821,144
bytes), total 462,555,489 bytes. No unknown sizes or objects above 25 MiB
were reported. The largest declared object was 2,860,266 bytes. The October 2
UTC creation cohort was 972 objects / 57,410,469 bytes; this is added-object
metadata, not proof of net growth, successful downloads or the cause of errors.
The bucket remains private with null size/MIME limits. A bounded read-only query
retrieved aggregates only; no private bytes/names were exported and no settings
were changed. Current observed image-only data does not remove generic-file
support from imports, so the MIME proposal remains deferred.
