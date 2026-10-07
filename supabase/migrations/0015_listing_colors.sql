-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Store module, listing colors: the filament colors a version prints in, read
-- from its 3MF on upload and edited by the creator, and which printed parts
-- need more than one (the AMS). Shown as swatches on the listing.
--
--   {"colors": [{"hex": "#d4af37", "name": "Silk gold"}, ...],
--    "parts":  [{"name": "Body", "colors": [0, 2], "ams": true}, ...]}
--
-- Part colors are indexes into colors. The existing listing_versions policies
-- cover the column: anyone who can read the version reads its colors, and only
-- the listing's creator can write them (versions_insert_owner,
-- versions_update_owner). guard_version_change leaves the column editable, like
-- the changelog, so a color fix does not send the listing back to review.
-- supabase/modules/drop_store.sql removes it with the table.

create function public.listing_colors_ok(c jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  n integer;
  col jsonb;
  part jsonb;
  idx jsonb;
begin
  if c is null then
    return true;
  end if;
  if jsonb_typeof(c) <> 'object' or jsonb_typeof(c -> 'colors') is distinct from 'array' or jsonb_typeof(c -> 'parts') is distinct from 'array' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(c) k where k not in ('colors', 'parts')) > 0 then
    return false;
  end if;
  n := jsonb_array_length(c -> 'colors');
  if n < 1 or n > 32 or jsonb_array_length(c -> 'parts') > 200 then
    return false;
  end if;
  for col in select * from jsonb_array_elements(c -> 'colors') loop
    if jsonb_typeof(col) <> 'object'
       or (select count(*) from jsonb_object_keys(col) k where k not in ('hex', 'name')) > 0
       or jsonb_typeof(col -> 'hex') is distinct from 'string'
       or (col ->> 'hex') !~ '^#[0-9a-f]{6}$' then
      return false;
    end if;
    if col ? 'name' and (jsonb_typeof(col -> 'name') <> 'string'
       or char_length(col ->> 'name') not between 1 and 40
       or (col ->> 'name') ~ '[<>[:cntrl:]]') then
      return false;
    end if;
  end loop;
  for part in select * from jsonb_array_elements(c -> 'parts') loop
    if jsonb_typeof(part) <> 'object'
       or (select count(*) from jsonb_object_keys(part) k where k not in ('name', 'colors', 'ams')) > 0
       or jsonb_typeof(part -> 'name') is distinct from 'string'
       or char_length(part ->> 'name') not between 1 and 120
       or (part ->> 'name') ~ '[<>[:cntrl:]]'
       or jsonb_typeof(part -> 'ams') is distinct from 'boolean'
       or jsonb_typeof(part -> 'colors') is distinct from 'array'
       or jsonb_array_length(part -> 'colors') not between 1 and 32 then
      return false;
    end if;
    for idx in select * from jsonb_array_elements(part -> 'colors') loop
      if jsonb_typeof(idx) <> 'number' or (idx #>> '{}') !~ '^\d{1,2}$' or (idx #>> '{}')::integer >= n then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;
-- The check runs as the writer, and the scan worker rewrites rows as the service role.
revoke execute on function public.listing_colors_ok(jsonb) from public;
grant execute on function public.listing_colors_ok(jsonb) to authenticated, service_role;

alter table public.listing_versions add column colors jsonb
  constraint listing_versions_colors_check check (public.listing_colors_ok(colors) and pg_column_size(colors) <= 16384);
