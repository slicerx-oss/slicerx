-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Table privileges for anon and authenticated on projects created without "automatically
-- expose new tables", where the api roles start with none. Each grant matches a row level
-- security policy the earlier migrations define: a role gets a command on a table only where a
-- policy lets it through, so the policies still decide which rows. Grants the earlier
-- migrations already give (profiles update columns, api_tokens columns, paired_devices,
-- account_deletions, audit_log, library_settings, downloads, moderation_queue, cloud_jobs,
-- cloud_deliveries, cloud_access) are not repeated. Tables with no client policy
-- (api_token_usage, storage_cleanup, the download grant tables) get nothing.

grant usage on schema public to anon, authenticated;

-- auth
grant select on public.profiles to anon, authenticated;

-- The tables below start from nothing, so a project that did expose new tables (the local
-- stack) ends with the same privileges as one that did not.
revoke all on
  public.creators, public.creator_links, public.creator_featured, public.follows, public.listings,
  public.listing_versions, public.listing_files, public.print_profiles, public.likes,
  public.comments, public.makes, public.collections, public.collection_items,
  public.cloud_devices, public.sync_profiles, public.sync_printers, public.sync_fleets
from anon, authenticated;
revoke all on sequence public.sync_revision_seq from anon, authenticated;

-- store: public reads
grant select on
  public.creators, public.creator_links, public.creator_featured, public.listings,
  public.listing_versions, public.listing_files, public.print_profiles, public.likes,
  public.comments, public.makes, public.collections, public.collection_items
to anon, authenticated;

-- store: member writes, one line per table as its policies allow
grant insert, update on public.creators to authenticated;
grant insert, update, delete on public.creator_links to authenticated;
grant insert, update, delete on public.creator_featured to authenticated;
grant select, insert, delete on public.follows to authenticated;
grant insert, update, delete on public.listings to authenticated;
grant insert, update on public.listing_versions to authenticated;
grant insert, update, delete on public.print_profiles to authenticated;
grant insert, delete on public.likes to authenticated;
grant insert, update on public.comments to authenticated;
grant insert, delete on public.makes to authenticated;
grant insert, update, delete on public.collections to authenticated;
grant insert, delete on public.collection_items to authenticated;

-- cloud: a member's devices and synced rows. Synced rows are never deleted by clients.
grant select, insert, update, delete on public.cloud_devices to authenticated;
grant select, insert, update on public.sync_profiles, public.sync_printers, public.sync_fleets to authenticated;
-- sync_stamp runs with the caller's rights and stamps each write from this sequence.
grant usage on sequence public.sync_revision_seq to authenticated;

-- Functions the clients call, and the ones row level security policies call with the caller's
-- rights. Postgres gives new functions to PUBLIC, but these are named so the clients keep them
-- on a project that also takes that away.
grant execute on function
  public.my_role(), public.listing_stats(uuid[]), public.creator_followers(uuid[]),
  public.is_staff(), public.user_banned(uuid), public.can_edit_listing(uuid),
  public.listing_visible(uuid), public.version_visible(uuid), public.collection_visible(uuid)
to anon, authenticated;
grant execute on function
  public.is_active_user(), public.is_creator_owner(uuid), public.version_listing(uuid),
  public.owns_collection(uuid), public.can_upload_quarantine(text), public.can_download(text)
to authenticated;
