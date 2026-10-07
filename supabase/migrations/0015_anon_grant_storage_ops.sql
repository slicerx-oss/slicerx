-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module: the hosted storage service names the direct read of
-- /object/authenticated/... 'object.get_authenticated_info' (the legacy
-- names, without the 'storage.' prefix), so the grant check in 0005 and
-- 0014 refused every signed-out download there. A grant now opens a file
-- under either naming scheme, for direct reads and info lookups only.
-- Signing a URL, listing and every write stay refused, so a short grant
-- still cannot become a long-lived link.

create or replace function public.is_direct_read_op(p_op text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_op = any (array[
    'storage.object.get_authenticated',
    'storage.object.info_authenticated',
    'object.get_authenticated',
    'object.get_authenticated_info',
    'object.head_authenticated_info',
    'object.info_authenticated'
  ]), false);
$$;
revoke execute on function public.is_direct_read_op(text) from public;
grant execute on function public.is_direct_read_op(text) to anon, authenticated, service_role;

create or replace function public.can_download_anon(p_path text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  op text := coalesce(current_setting('storage.operation', true), '');
  token text := coalesce(
    h ->> 'x-sx-download-grant',
    substring(coalesce(current_setting('request.path', true), '') from '[?&]sx_grant=(sxg_[0-9a-f]{48})(?:&|$)')
  );
begin
  if not (select anon_downloads from public.library_settings) then
    return false;
  end if;
  if public.is_public_image(p_path) then
    return true;
  end if;
  if token is null or not public.is_direct_read_op(op) then
    return false;
  end if;
  return exists (
    select 1 from public.download_grants g
    where g.token_hash = encode(extensions.digest(token, 'sha256'), 'hex')
      and g.storage_path = p_path and g.expires_at > now()
  ) and public.is_public_file(p_path);
end;
$$;

revoke execute on function public.can_download_anon(text) from public;
grant execute on function public.can_download_anon(text) to anon;
