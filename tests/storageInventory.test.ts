import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
}, 30000);
afterAll(async () => { await db?.close(); });

it('runs inventory read-only against disposable synthetic storage metadata', async () => {
  {
    await db.exec(`create schema storage;
      create table storage.buckets(id text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects(bucket_id text, created_at timestamptz, metadata jsonb);
      create table public.shared_attachments(storage_bucket text, mime_type text, size_bytes bigint, deleted_at timestamptz);
      insert into storage.buckets values ('punchlist-attachments', false, null, null);
      insert into storage.objects values
        ('punchlist-attachments', now(), '{"size":"26214401","mimetype":"image/jpeg"}'),
        ('punchlist-attachments', now(), '{"size":"unknown"}'),
        ('other', now(), '{"size":"999999999"}');
      insert into public.shared_attachments values ('punchlist-attachments', 'image/jpeg', 26214401, null);`);
    const results = await db.exec(readFileSync('scripts/storage-inventory.sql', 'utf8'));
    const mimeRows = results.find((result) => result.rows.some((row) => 'over_proposed_limit_count' in row))!.rows;
    expect(mimeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ mime_type: 'image/jpeg', object_count: 1, over_proposed_limit_count: 1 }),
      expect.objectContaining({ mime_type: '(unknown)', unknown_size_count: 1 }),
    ]));
    expect((await db.query('select count(*) as count from storage.objects')).rows).toEqual([{ count: 3 }]);
  }
});
