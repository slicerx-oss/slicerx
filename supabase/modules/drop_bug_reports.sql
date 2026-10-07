-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Removes crash and bug reports (migrations/0012_bug_reports.sql). Files in the
-- bug-reports bucket must be removed through the Storage API first; the bucket
-- is dropped only when empty.
-- Newer storage versions refuse SQL deletes unless asked; the buckets go only when empty.
set local storage.allow_delete_query = 'true';
delete from storage.buckets b where b.id = 'bug-reports' and not exists (
  select 1 from storage.objects o where o.bucket_id = b.id
);
drop function if exists public.submit_bug_report(text, uuid, text, text, text, text, text, text, text, text, text);
drop table if exists public.bug_reports;
