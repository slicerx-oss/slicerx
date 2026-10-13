-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Saved free mimir chats during alpha. Each edition says whether a call is saved when the
-- client does not say (share_default: on for SlicerX here; LayerMate turns on once its app
-- shows the notice, a one-row update), so older kits save with no change; a client opts out with x-sx-share: 0. A saved chat keeps its tool calls in full,
-- so a design can be replayed, and its system prompt and tool list once per distinct text
-- (mimir_prompts) instead of in every turn. Everything goes after 30 days: an hourly job, and
-- the sweep in mimir_settle. mimir_forget still deletes an install's sessions.

alter table public.mimir_limits add column share_default boolean not null default false;
update public.mimir_limits set share_default = true where edition = 'slicerx';
-- free mimir is $5 a day per edition (owner, 2026-10-13); production was set by hand the same day
update public.mimir_limits set edition_daily_micros = 5000000 where edition = 'slicerx';

-- a design session carries its geometry ops in every turn, so a turn may run to 1 MB
alter table public.mimir_sessions drop constraint mimir_sessions_transcript_check;
alter table public.mimir_sessions add constraint mimir_sessions_transcript_check check (octet_length(transcript::text) <= 1048576);
alter table public.mimir_limits alter column install_store_daily_bytes set default 33554432;
update public.mimir_limits set install_store_daily_bytes = 33554432 where install_store_daily_bytes = 8388608;

-- A system prompt and tool list, once per edition and distinct text (sha256 of its JSON).
create table public.mimir_prompts (
  edition text not null references public.mimir_limits (edition),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  body jsonb not null check (octet_length(body::text) <= 1048576),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  primary key (edition, hash)
);
create index mimir_prompts_last_used_idx on public.mimir_prompts (last_used_at);
alter table public.mimir_prompts enable row level security;
revoke all on public.mimir_prompts from public, anon, authenticated;
grant select, insert, update, delete on public.mimir_prompts to service_role;

-- Saves the latest turn of the call's chat, once the call has settled and only once per
-- call. p_share is the client's choice (null when it said nothing, then the edition's
-- default decides). Returns false, saving nothing, when sharing is off, the turn is over
-- 1 MB or the install has written its bytes for the day.
create function public.mimir_save_chat(p_call uuid, p_share boolean, p_session_key text, p_app_version text,
  p_model text, p_prompt_hash text, p_prompt jsonb, p_transcript jsonb) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_call public.mimir_calls;
  v_lim public.mimir_limits;
  v_bytes integer := octet_length(p_transcript::text);
begin
  select * into v_call from public.mimir_calls where id = p_call for update;
  if not found or v_call.settled_at is null or v_call.stored_bytes is not null then
    raise exception 'unknown, open or stored call' using errcode = '22023', hint = 'invalid';
  end if;
  select * into v_lim from public.mimir_limits where edition = v_call.edition;
  if not coalesce(p_share, v_lim.share_default) then
    update public.mimir_calls set stored_bytes = 0 where id = p_call;
    return false;
  end if;
  -- one save at a time per install, so the day's sum below holds
  perform 1 from public.mimir_installs where id = v_call.install_id for update;
  if v_bytes > 1048576 or (select coalesce(sum(stored_bytes), 0) from public.mimir_calls
      where install_id = v_call.install_id and day = v_call.day) + v_bytes > v_lim.install_store_daily_bytes then
    update public.mimir_calls set stored_bytes = 0 where id = p_call;
    return false;
  end if;
  if p_prompt_hash is not null then
    insert into public.mimir_prompts (edition, hash, body) values (v_call.edition, p_prompt_hash, p_prompt)
    on conflict (edition, hash) do update set last_used_at = now();
  end if;
  update public.mimir_calls set stored_bytes = v_bytes where id = p_call;
  insert into public.mimir_sessions as s (install_id, session_key, edition, app_version, model, cost_micros, transcript)
  values (v_call.install_id, p_session_key, v_call.edition, p_app_version, p_model,
    coalesce(v_call.cost_micros, 0), p_transcript)
  on conflict (install_id, session_key) do update set
    app_version = excluded.app_version, model = excluded.model, turns = s.turns + 1,
    cost_micros = s.cost_micros + excluded.cost_micros, transcript = excluded.transcript, updated_at = now();
  return true;
end;
$$;

-- Deletes saved chats and prompts unused for 30 days, a batch at a time. Returns how many rows went.
create function public.mimir_expire_saved(p_batch integer default 1000) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
  v_m integer;
begin
  delete from public.mimir_sessions where (install_id, session_key) in (
    select install_id, session_key from public.mimir_sessions where updated_at < now() - interval '30 days' limit p_batch);
  get diagnostics v_n = row_count;
  delete from public.mimir_prompts where (edition, hash) in (
    select edition, hash from public.mimir_prompts where last_used_at < now() - interval '30 days' limit p_batch);
  get diagnostics v_m = row_count;
  return v_n + v_m;
end;
$$;

-- The sweep in mimir_settle follows the same 30 days.
create or replace function public.mimir_settle(p_call uuid, p_model text, p_input bigint, p_cache_write bigint,
  p_cache_read bigint, p_output bigint, p_searches integer) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cost bigint := public.mimir_cost(p_model, p_input, p_cache_write, p_cache_read, p_output, p_searches);
begin
  update public.mimir_calls set cost_micros = v_cost, input_tokens = p_input, cache_write_tokens = p_cache_write,
    cache_read_tokens = p_cache_read, output_tokens = p_output, web_searches = p_searches, settled_at = now()
  where id = p_call and settled_at is null;
  if not found then
    raise exception 'unknown or settled call' using errcode = '22023', hint = 'invalid';
  end if;
  delete from public.mimir_calls where id in (
    select id from public.mimir_calls where created_at < now() - interval '90 days' limit 100);
  delete from public.mimir_sessions where (install_id, session_key) in (
    select install_id, session_key from public.mimir_sessions where updated_at < now() - interval '30 days' limit 100);
  return v_cost;
end;
$$;

-- The reader sees the prompts behind its edition's sessions.
create function public.mimir_reader_prompt(p_hash text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select p.body from public.mimir_prompts p where p.hash = p_hash and p.edition = public.mimir_reader_edition();
$$;

revoke execute on function public.mimir_save_chat(uuid, boolean, text, text, text, text, jsonb, jsonb),
  public.mimir_expire_saved(integer), public.mimir_reader_prompt(text) from public, anon, authenticated;
grant execute on function public.mimir_save_chat(uuid, boolean, text, text, text, text, jsonb, jsonb),
  public.mimir_expire_saved(integer) to service_role;
grant execute on function public.mimir_reader_prompt(text) to mimir_session_reader, service_role;

-- hourly, Melbourne or not: retention is counted from each row's own time
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('mimir-expire-saved', '17 * * * *', 'select public.mimir_expire_saved()');
