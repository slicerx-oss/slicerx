-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module: a download grant may also travel in the object URL's query
-- (?sx_grant=sxg_...), which storage passes to policies as request.path. On
-- the hosted project a read carrying the grant only in the header was
-- refused, so every signed-out download failed, while a local stack with a
-- newer storage version accepts the header. The header still works. Everything else is as 0005: a live grant for
-- exactly this path, a direct read only (never signing), and a public file.

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
  if token is null or op not in ('storage.object.get_authenticated', 'storage.object.info_authenticated') then
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
