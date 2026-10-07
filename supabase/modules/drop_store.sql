-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Removes the store module (migrations/0002_store.sql, 0005_anon_downloads.sql and 0013_creator_pages.sql). Leaves auth.users,
-- profiles, roles, the audit log, api_tokens and paired_devices untouched.
-- Files already in the uploads-quarantine and listing-files buckets must be removed
-- through the Storage API first; the buckets are dropped only when empty.
drop policy if exists uploads_quarantine_upload on storage.objects;
drop policy if exists uploads_quarantine_replace on storage.objects;
drop policy if exists listing_files_download on storage.objects;
drop policy if exists listing_files_download_anon on storage.objects;
drop policy if exists creator_media_insert on storage.objects;
drop policy if exists creator_media_select_own on storage.objects;
drop policy if exists creator_media_delete_own on storage.objects;
-- Newer storage versions refuse SQL deletes unless asked; the buckets go only when empty.
set local storage.allow_delete_query = 'true';
delete from storage.buckets b where b.id in ('uploads-quarantine', 'listing-files', 'creator-media') and not exists (
  select 1 from storage.objects o where o.bucket_id = b.id
);
-- claim_scan returns the listing_versions row type, so it goes before the tables.
drop function if exists public.claim_scan(text);
drop view if exists public.moderation_queue;
drop table if exists
  public.download_grants, public.anon_downloads, public.anon_download_usage, public.download_secret,
  public.storage_cleanup, public.downloads, public.collection_items, public.collections,
  public.makes, public.comments, public.likes, public.creator_featured, public.print_profiles,
  public.listing_files, public.listing_versions, public.listings, public.follows, public.creator_links,
  public.creators, public.library_settings;
drop function if exists
  public.set_saved(uuid, boolean), public.saved_listings(), public.trending_listings(integer, integer),
  public.new_creators(integer, integer), public.recommended_listings(integer),
  public.can_write_creator_media(text), public.queue_creator_media_cleanup(), public.is_sealed_path(text),
  public.request_download(uuid), public.can_download_anon(text), public.set_anon_downloads(boolean, integer, integer),
  public.is_public_image(text), public.is_public_file(text), public.public_download_path(uuid),
  public.client_ip_hash(), public.client_ip(),
  public.can_download(text), public.can_upload_quarantine(text), public.path_listing(text),
  public.creator_followers(uuid[]), public.listing_stats(uuid[]), public.record_download(uuid),
  public.creator_dashboard(), public.collection_visible(uuid), public.owns_collection(uuid),
  public.version_visible(uuid), public.version_listing(uuid), public.listing_visible(uuid),
  public.can_edit_listing(uuid), public.is_creator_owner(uuid), public.can_moderate(),
  public.approve_listing(uuid, text), public.reject_listing(uuid, text), public.remove_listing(uuid, text),
  public.set_moderation_mode(text), public.set_creator_trusted(uuid, boolean), public.submit_version(uuid),
  public.requeue_stale_scans(interval), public.finish_scan(uuid, boolean, jsonb, text, bigint, jsonb, text, text),
  public.version_scan_report(uuid), public.retry_scan(uuid, text), public.apply_library_settings(text, integer, text[]), public.guard_listing_change(), public.guard_version_change(),
  public.guard_creator_update(), public.guard_creator_insert(), public.promote_creator(),
  public.check_creator_link(), public.check_featured(), public.unfeature_listing(),
  public.queue_listing_cleanup(), public.guard_comment_update(), public.delete_comment(uuid);
