-- Read-only aggregate inventory; no object names, contents, or cleanup.
-- Run with a database role permitted to read storage metadata.
begin read only;
set local statement_timeout = '15s';
select id, public, file_size_limit, allowed_mime_types
from storage.buckets where id = 'punchlist-attachments';

-- Includes every immutable version, even when application metadata no longer
-- refers to it. Unknown sizes are reported rather than silently counted as zero.
with objects as (
  select created_at, coalesce(metadata->>'mimetype', '(unknown)') as mime_type,
    case when metadata->>'size' ~ '^[0-9]+$'
      then (metadata->>'size')::numeric end as bytes
  from storage.objects where bucket_id = 'punchlist-attachments'
)
select mime_type, count(*) as object_count, sum(bytes) as known_bytes,
  count(*) filter (where bytes is null) as unknown_size_count,
  max(bytes) as largest_bytes,
  count(*) filter (where bytes > 26214400) as over_proposed_limit_count
from objects group by mime_type order by known_bytes desc nulls last;

-- Creation cohorts measure bytes added, not historical net growth or billing.
with objects as (
  select created_at, case when metadata->>'size' ~ '^[0-9]+$'
    then (metadata->>'size')::numeric end as bytes
  from storage.objects where bucket_id = 'punchlist-attachments'
)
select date_trunc('day', created_at at time zone 'UTC') as created_day_utc,
  count(*) as added_objects, sum(bytes) as known_added_bytes,
  count(*) filter (where bytes is null) as unknown_size_count
from objects group by 1 order by 1 desc limit 30;

-- Soft-deleted metadata is not a safe deletion candidate: snapshot history may
-- still reference those immutable objects.
select mime_type, (deleted_at is not null) as metadata_soft_deleted,
  count(*) as metadata_rows, sum(size_bytes) as declared_bytes,
  max(size_bytes) as largest_declared_bytes
from public.shared_attachments
where storage_bucket = 'punchlist-attachments'
group by 1, 2 order by declared_bytes desc;
commit;
