-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir's cloud model: the mimir edge function (supabase/functions/mimir) sends an
-- install's chat to the model provider with the project's own key, and holds every
-- install to daily spend caps. Nobody signs in. An install registers once and gets a
-- token; each model call reserves its worst-case cost against the install's, the
-- IP's and the edition's caps for the Melbourne day, and settles the real cost when
-- the reply ends. Installs that share their sessions (on by default, with an off
-- switch in the app) have the conversation stored here for 180 days.
--
-- Clients never touch any of it: only the service role (the edge function) calls
-- these functions. The mimir_session_reader role reads sessions of one edition
-- (layermate), for the edition's owner; turning it on is a deployment step:
-- alter role mimir_session_reader with login password '<secret>'.

-- Caps per edition, in micro-dollars per Melbourne day.
create table public.mimir_limits (
  edition text primary key check (edition ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  enabled boolean not null default true,
  edition_daily_micros bigint not null check (edition_daily_micros >= 0),
  install_daily_micros bigint not null default 500000 check (install_daily_micros >= 0),
  ip_daily_micros bigint not null default 2000000 check (ip_daily_micros >= 0),
  install_per_minute integer not null default 20 check (install_per_minute between 1 and 600),
  registers_per_ip_day integer not null default 3 check (registers_per_ip_day between 1 and 1000)
);
insert into public.mimir_limits (edition, edition_daily_micros) values
  ('slicerx', 20000000),
  ('layermate', 5000000);

-- Model prices in micro-dollars: per million tokens, and per web search. Prompts over
-- long_above input tokens bill at the long rates. Cache writes cost 1.25x input and
-- cache reads 0.1x (5-minute cache).
create table public.mimir_prices (
  model text primary key check (char_length(model) between 1 and 80),
  input_mtok bigint not null check (input_mtok >= 0),
  output_mtok bigint not null check (output_mtok >= 0),
  long_above bigint not null check (long_above > 0),
  long_input_mtok bigint not null check (long_input_mtok >= 0),
  long_output_mtok bigint not null check (long_output_mtok >= 0),
  search_each bigint not null check (search_each >= 0)
);
insert into public.mimir_prices values ('claude-haiku-5-5', 100000, 500000, 100000, 500000, 2500000, 10000);

-- The salt for IP hashes. One row, read only by the functions below.
create table public.mimir_secret (
  id boolean primary key default true check (id),
  salt bytea not null default extensions.gen_random_bytes(32)
);
insert into public.mimir_secret default values;

create table public.mimir_installs (
  id uuid primary key default gen_random_uuid(),
  edition text not null references public.mimir_limits (edition),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  created_ip_hash text not null
);
create index mimir_installs_ip_idx on public.mimir_installs (created_ip_hash);

-- One row per model call. cost_micros is null until the call settles; until then
-- the reservation counts.
create table public.mimir_calls (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  created_at timestamptz not null default now(),
  edition text not null references public.mimir_limits (edition),
  install_id uuid not null references public.mimir_installs (id) on delete cascade,
  ip_hash text not null,
  reserved_micros bigint not null check (reserved_micros >= 0),
  cost_micros bigint check (cost_micros >= 0),
  input_tokens bigint,
  cache_write_tokens bigint,
  cache_read_tokens bigint,
  output_tokens bigint,
  web_searches integer,
  settled_at timestamptz
);
create index mimir_calls_install_day_idx on public.mimir_calls (install_id, day);
create index mimir_calls_ip_day_idx on public.mimir_calls (ip_hash, day);
create index mimir_calls_edition_day_idx on public.mimir_calls (edition, day);
create index mimir_calls_created_idx on public.mimir_calls (created_at);

-- Shared sessions: the latest request and reply of a conversation (each turn
-- carries the whole history, so the last one is complete).
create table public.mimir_sessions (
  install_id uuid not null references public.mimir_installs (id) on delete cascade,
  session_key text not null check (session_key ~ '^[A-Za-z0-9_-]{1,64}$'),
  edition text not null references public.mimir_limits (edition),
  app_version text not null check (char_length(app_version) between 1 and 40),
  model text not null check (char_length(model) between 1 and 80),
  turns integer not null default 1 check (turns >= 1),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  transcript jsonb not null check (octet_length(transcript::text) <= 4194304),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (install_id, session_key)
);
create index mimir_sessions_edition_updated_idx on public.mimir_sessions (edition, updated_at);

alter table public.mimir_limits enable row level security;
alter table public.mimir_prices enable row level security;
alter table public.mimir_secret enable row level security;
alter table public.mimir_installs enable row level security;
alter table public.mimir_calls enable row level security;
alter table public.mimir_sessions enable row level security;
revoke all on public.mimir_limits, public.mimir_prices, public.mimir_secret, public.mimir_installs,
  public.mimir_calls, public.mimir_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.mimir_limits, public.mimir_prices, public.mimir_installs,
  public.mimir_calls, public.mimir_sessions to service_role;

-- The Melbourne day, which every cap counts in.
create function public.mimir_day() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Australia/Melbourne')::date;
$$;

-- HMAC of the IP and the Melbourne day, so counts cannot be linked across days.
-- No IP shares one bucket.
create function public.mimir_ip_hash(p_ip text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(
    convert_to(coalesce(nullif(btrim(p_ip), ''), 'unknown') || '|' || public.mimir_day()::text, 'UTF8'),
    (select salt from public.mimir_secret), 'sha256'), 'hex');
$$;

create function public.mimir_token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'), 'hex');
$$;

-- A new install for p_edition. Returns its id and token; only the token's hash is kept.
create function public.mimir_register(p_edition text, p_ip text)
returns table (install_id uuid, token text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_lim public.mimir_limits;
  v_ip text := public.mimir_ip_hash(p_ip);
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  select * into v_lim from public.mimir_limits where edition = p_edition;
  if not found then
    raise exception 'unknown edition' using errcode = '22023', hint = 'invalid';
  end if;
  if not v_lim.enabled then
    raise exception 'mimir is paused' using errcode = 'P0001', hint = 'paused';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.mimir_register'));
  if (select count(*) from public.mimir_installs where created_ip_hash = v_ip) >= v_lim.registers_per_ip_day then
    raise exception 'too many new installs from this address today' using errcode = 'P0001', hint = 'register_limit';
  end if;
  insert into public.mimir_installs (edition, token_hash, created_ip_hash)
  values (p_edition, public.mimir_token_hash(v_token), v_ip)
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

-- The cost of a call from its usage, at p_model's prices.
create function public.mimir_cost(p_model text, p_input bigint, p_cache_write bigint, p_cache_read bigint,
  p_output bigint, p_searches integer) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.mimir_prices;
  v_in bigint := coalesce(p_input, 0) + coalesce(p_cache_write, 0) + coalesce(p_cache_read, 0);
  v_rate_in bigint;
  v_rate_out bigint;
begin
  select * into p from public.mimir_prices where model = p_model;
  if not found then
    raise exception 'no price for model' using errcode = '22023', hint = 'invalid';
  end if;
  v_rate_in := case when v_in > p.long_above then p.long_input_mtok else p.input_mtok end;
  v_rate_out := case when v_in > p.long_above then p.long_output_mtok else p.output_mtok end;
  -- micro-dollars per token = rate / 1e6; round up so caps never undercount
  return ceil((coalesce(p_input, 0) * v_rate_in
    + coalesce(p_cache_write, 0) * v_rate_in * 1.25
    + coalesce(p_cache_read, 0) * v_rate_in * 0.1
    + coalesce(p_output, 0) * v_rate_out) / 1000000.0)::bigint
    + coalesce(p_searches, 0) * p.search_each;
end;
$$;

-- Reserves the worst case of one call (p_input prompt tokens at the uncached rate,
-- p_output reply tokens and p_searches web searches at p_model's prices) for the
-- install holding p_token, from p_ip, against every cap. Raises with a hint naming
-- the cap that was hit.
create function public.mimir_reserve(p_token text, p_ip text, p_model text, p_input bigint, p_output bigint,
  p_searches integer) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inst public.mimir_installs;
  v_lim public.mimir_limits;
  v_day date := public.mimir_day();
  v_ip text := public.mimir_ip_hash(p_ip);
  v_id uuid;
  p_max_micros bigint;
begin
  if p_input is null or p_input < 0 or p_output is null or p_output < 0 or p_searches is null or p_searches < 0 then
    raise exception 'bad reservation' using errcode = '22023', hint = 'invalid';
  end if;
  p_max_micros := public.mimir_cost(p_model, p_input, 0, 0, p_output, p_searches);
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where edition = v_inst.edition;
  if not v_lim.enabled then
    raise exception 'mimir is paused' using errcode = 'P0001', hint = 'paused';
  end if;
  -- One reservation per edition at a time, so two calls cannot both slip under a cap.
  perform pg_advisory_xact_lock(hashtext('public.mimir_reserve:' || v_inst.edition));
  if (select count(*) from public.mimir_calls
      where install_id = v_inst.id and created_at > now() - interval '1 minute') >= v_lim.install_per_minute then
    raise exception 'too many requests' using errcode = 'P0001', hint = 'install_rate';
  end if;
  if (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where install_id = v_inst.id and day = v_day) + p_max_micros > v_lim.install_daily_micros then
    raise exception 'daily limit for this install reached' using errcode = 'P0001', hint = 'install_daily';
  end if;
  if (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where ip_hash = v_ip and day = v_day) + p_max_micros > v_lim.ip_daily_micros then
    raise exception 'daily limit for this address reached' using errcode = 'P0001', hint = 'ip_daily';
  end if;
  if (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where edition = v_inst.edition and day = v_day) + p_max_micros > v_lim.edition_daily_micros then
    raise exception 'daily limit for this edition reached' using errcode = 'P0001', hint = 'edition_daily';
  end if;
  insert into public.mimir_calls (day, edition, install_id, ip_hash, reserved_micros)
  values (v_day, v_inst.edition, v_inst.id, v_ip, p_max_micros)
  returning id into v_id;
  return v_id;
end;
$$;

-- Settles a reservation with what the call used. Returns the cost. Also clears
-- expired rows a few at a time: calls after 90 days, shared sessions after 180.
create function public.mimir_settle(p_call uuid, p_model text, p_input bigint, p_cache_write bigint,
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
    select install_id, session_key from public.mimir_sessions where updated_at < now() - interval '180 days' limit 100);
  return v_cost;
end;
$$;

-- Stores a shared session's latest turn for the install that made p_call.
create function public.mimir_store_session(p_call uuid, p_session_key text, p_app_version text, p_model text,
  p_transcript jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_call public.mimir_calls;
begin
  select * into v_call from public.mimir_calls where id = p_call;
  if not found then
    raise exception 'unknown call' using errcode = '22023', hint = 'invalid';
  end if;
  insert into public.mimir_sessions as s (install_id, session_key, edition, app_version, model, cost_micros, transcript)
  values (v_call.install_id, p_session_key, v_call.edition, p_app_version, p_model,
    coalesce(v_call.cost_micros, 0), p_transcript)
  on conflict (install_id, session_key) do update set
    app_version = excluded.app_version, model = excluded.model, turns = s.turns + 1,
    cost_micros = s.cost_micros + excluded.cost_micros, transcript = excluded.transcript, updated_at = now();
end;
$$;

-- Deletes every shared session of the install holding p_token. Returns how many.
create function public.mimir_forget(p_token text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_n integer;
begin
  select id into v_id from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  delete from public.mimir_sessions where install_id = v_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Today's use and caps for the install holding p_token, for the app and its clients.
create function public.mimir_quota(p_token text, p_ip text)
returns table (edition text, day date, install_used bigint, install_cap bigint, ip_used bigint, ip_cap bigint,
  edition_open boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_inst public.mimir_installs;
  v_lim public.mimir_limits;
  v_day date := public.mimir_day();
  v_ip text := public.mimir_ip_hash(p_ip);
begin
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where mimir_limits.edition = v_inst.edition;
  return query select v_inst.edition, v_day,
    (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0)::bigint from public.mimir_calls
      where install_id = v_inst.id and mimir_calls.day = v_day),
    v_lim.install_daily_micros,
    (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0)::bigint from public.mimir_calls
      where ip_hash = v_ip and mimir_calls.day = v_day),
    v_lim.ip_daily_micros,
    v_lim.enabled and (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where mimir_calls.edition = v_inst.edition and mimir_calls.day = v_day) < v_lim.edition_daily_micros;
end;
$$;

revoke execute on function public.mimir_day(), public.mimir_ip_hash(text), public.mimir_token_hash(text),
  public.mimir_register(text, text), public.mimir_reserve(text, text, text, bigint, bigint, integer),
  public.mimir_cost(text, bigint, bigint, bigint, bigint, integer),
  public.mimir_settle(uuid, text, bigint, bigint, bigint, bigint, integer),
  public.mimir_store_session(uuid, text, text, text, jsonb), public.mimir_forget(text),
  public.mimir_quota(text, text) from public, anon, authenticated;
grant execute on function public.mimir_register(text, text), public.mimir_reserve(text, text, text, bigint, bigint, integer),
  public.mimir_settle(uuid, text, bigint, bigint, bigint, bigint, integer),
  public.mimir_store_session(uuid, text, text, text, jsonb), public.mimir_forget(text),
  public.mimir_quota(text, text) to service_role;

-- Read-only access to one edition's shared sessions --------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mimir_session_reader') then
    create role mimir_session_reader nologin noinherit connection limit 2;
  end if;
end;
$$;
alter role mimir_session_reader set statement_timeout = '10s';
alter role mimir_session_reader set search_path = '';
grant usage on schema public to mimir_session_reader;

-- The edition the reader may see. Fixed here; another edition means another role.
create function public.mimir_reader_edition() returns text
language sql immutable set search_path = '' as $$ select 'layermate'::text $$;

-- Shared sessions updated after p_since, newest last, without transcripts.
create function public.mimir_reader_sessions(p_since timestamptz default '-infinity', p_limit integer default 100)
returns table (install_id uuid, session_key text, app_version text, model text, turns integer, cost_micros bigint,
  created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.install_id, s.session_key, s.app_version, s.model, s.turns, s.cost_micros, s.created_at, s.updated_at
  from public.mimir_sessions s
  where s.edition = public.mimir_reader_edition() and s.updated_at > p_since
  order by s.updated_at
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
$$;

-- One shared session's transcript, or nothing outside the reader's edition.
create function public.mimir_reader_session(p_install uuid, p_session_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select s.transcript from public.mimir_sessions s
  where s.install_id = p_install and s.session_key = p_session_key and s.edition = public.mimir_reader_edition();
$$;

revoke execute on function public.mimir_reader_edition(), public.mimir_reader_sessions(timestamptz, integer),
  public.mimir_reader_session(uuid, text) from public, anon, authenticated;
grant execute on function public.mimir_reader_sessions(timestamptz, integer), public.mimir_reader_session(uuid, text)
  to mimir_session_reader, service_role;
