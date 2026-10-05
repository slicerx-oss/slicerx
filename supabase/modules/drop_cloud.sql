-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Removes the cloud module (migrations/0004_cloud.sql, 0006_cloud_access.sql and
-- 0007_cloud_retention.sql). Leaves auth.users, profiles and api_tokens
-- untouched. Files in the cloud-inputs and cloud-results buckets must be
-- removed through the Storage API first; the buckets are dropped only when
-- empty.
drop policy if exists cloud_files_read_own on storage.objects;
delete from storage.buckets b where b.id in ('cloud-inputs', 'cloud-results') and not exists (
  select 1 from storage.objects o where o.bucket_id = b.id
);
-- claim_cloud_job returns the cloud_jobs row type, so it goes before the table.
drop function if exists public.claim_cloud_job(text, integer);
drop function if exists
  public.expire_cloud_files(integer, integer),
  public.grant_cloud_access(text, integer, integer, text), public.revoke_cloud_access(text),
  public.my_cloud_quota(), public.cloud_quota(uuid);
drop table if exists
  public.cloud_access, public.cloud_deliveries, public.cloud_jobs, public.sync_fleets, public.sync_printers,
  public.sync_profiles, public.cloud_devices;
drop function if exists
  public.sync_pull(bigint, integer), public.sync_push(jsonb, uuid), public.cancel_cloud_job(uuid),
  public.cancel_cloud_delivery(uuid), public.offer_delivery(),
  public.guard_delivery_state(), public.check_cloud_job(), public.guard_cloud_job(), public.check_fleet_members(),
  public.check_printer_profile(), public.sync_stamp(), public.has_cloud_access(uuid);
drop sequence if exists public.sync_revision_seq;
