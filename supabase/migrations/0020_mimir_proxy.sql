-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- mimir's cloud model: the mimir edge function (supabase/functions/mimir) sends an
-- install's chat to the model provider with the project's own key, and holds every
-- install to daily spend caps. Nobody signs in. An install registers once, with its
-- edition's registration key from the build, and gets a token; each model call reserves
-- its worst-case cost against the install's, the IP's and the edition's caps for the
-- Melbourne day, and settles the real cost when the reply ends. Installs that share their sessions (on by default, with an off
-- switch in the app) have the conversation stored here for 180 days.
--
-- Clients never touch any of it: only the service role (the edge function) calls
-- these functions. The mimir_session_reader role reads sessions of one edition
-- (layermate), for the edition's owner; turning it on is a deployment step:
-- alter role mimir_session_reader with login password '<secret>'.
--
-- Registration keys are deployment steps too. An edition with no key registers nothing.
-- Set one: update public.mimir_limits set register_key_hash = public.mimir_token_hash('<key>')
--   where edition = 'slicerx';
-- Rotate: move the current hash to register_key_prev_hash, set the new one, ship builds
-- with the new key, then clear register_key_prev_hash once the old builds are gone.

-- Caps per edition, in micro-dollars per Melbourne day.
create table public.mimir_limits (
  edition text primary key check (edition ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  enabled boolean not null default true,
  edition_daily_micros bigint not null check (edition_daily_micros >= 0),
  install_daily_micros bigint not null default 500000 check (install_daily_micros >= 0),
  ip_daily_micros bigint not null default 2000000 check (ip_daily_micros >= 0),
  install_per_minute integer not null default 20 check (install_per_minute between 1 and 600),
  registers_per_ip_day integer not null default 3 check (registers_per_ip_day between 1 and 1000),
  -- the same per IPv6 /48, the block one site or tunnel gets: many /64s, one owner
  registers_per_net_day integer not null default 20 check (registers_per_net_day between 1 and 100000),
  net_daily_micros bigint not null default 6000000 check (net_daily_micros >= 0),
  -- new installs per edition per Melbourne day, whatever their addresses
  registers_per_day integer not null default 5000 check (registers_per_day between 1 and 1000000),
  -- requests per address per minute, refused ones included
  ip_per_minute integer not null default 60 check (ip_per_minute between 1 and 6000),
  -- calls not yet settled, per install, per address, per IPv6 /48 and per edition; the
  -- edition's is far above any one network's share, so one network cannot hold every slot.
  -- An IPv4 address behind carrier NAT is many people, so its share is not too tight.
  install_in_flight integer not null default 3 check (install_in_flight between 1 and 100),
  ip_in_flight integer not null default 10 check (ip_in_flight between 1 and 1000),
  net_in_flight integer not null default 24 check (net_in_flight between 1 and 10000),
  edition_in_flight integer not null default 400 check (edition_in_flight between 1 and 100000),
  -- how long an unsettled call counts as in flight: just over the edge function's wall
  -- clock limit, so a call the runtime killed frees its slot
  call_open_seconds integer not null default 420 check (call_open_seconds between 60 and 3600),
  -- shared session bytes an install may write per Melbourne day
  install_store_daily_bytes bigint not null default 8388608 check (install_store_daily_bytes >= 0),
  -- sha256 of the edition's registration key, and of the previous key while it rotates out
  register_key_hash text check (register_key_hash ~ '^[0-9a-f]{64}$'),
  register_key_prev_hash text check (register_key_prev_hash ~ '^[0-9a-f]{64}$')
);
insert into public.mimir_limits (edition, edition_daily_micros) values
  ('slicerx', 20000000),
  ('layermate', 5000000);

-- Model prices in micro-dollars: per million tokens, and per web search. Prompts over
-- long_above input tokens (cache reads and writes included) bill at the long rates. Cache
-- writes cost 1.25x input and cache reads 0.1x; the proxy only sends the 5-minute cache.
-- Haiku 5.5 as published on 2026-10-12: $0.10 and $0.50 per million up to 100K prompt
-- tokens, $0.50 and $2.50 above, web search $10 per 1,000
-- (https://platform.claude.com/docs/en/about-claude/pricing).
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
  created_ip_hash text not null,
  -- the IPv6 /48 it registered from (null for IPv4)
  created_net_hash text,
  -- the last reservation; an install never used for 7 days, or idle for 30 with no shared
  -- sessions, is removed
  last_call_at timestamptz
);
create index mimir_installs_ip_idx on public.mimir_installs (created_ip_hash);
create index mimir_installs_edition_created_idx on public.mimir_installs (edition, created_at);
create index mimir_installs_unused_idx on public.mimir_installs (created_at) where last_call_at is null;
create index mimir_installs_idle_idx on public.mimir_installs (last_call_at);
create index mimir_installs_net_idx on public.mimir_installs (created_net_hash) where created_net_hash is not null;

-- One row per model call. cost_micros is null until the call settles; until then
-- the reservation counts.
create table public.mimir_calls (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  created_at timestamptz not null default now(),
  edition text not null references public.mimir_limits (edition),
  install_id uuid not null references public.mimir_installs (id) on delete cascade,
  ip_hash text not null,
  -- the IPv6 /48 (null for IPv4)
  net_hash text,
  reserved_micros bigint not null check (reserved_micros >= 0),
  cost_micros bigint check (cost_micros >= 0),
  input_tokens bigint,
  cache_write_tokens bigint,
  cache_read_tokens bigint,
  output_tokens bigint,
  web_searches integer,
  settled_at timestamptz,
  -- bytes of shared session this call stored, once it stored one
  stored_bytes integer check (stored_bytes >= 0)
);
create index mimir_calls_install_day_idx on public.mimir_calls (install_id, day);
create index mimir_calls_ip_day_idx on public.mimir_calls (ip_hash, day);
create index mimir_calls_edition_day_idx on public.mimir_calls (edition, day);
create index mimir_calls_created_idx on public.mimir_calls (created_at);
create index mimir_calls_open_idx on public.mimir_calls (edition, created_at) where settled_at is null;
create index mimir_calls_ip_open_idx on public.mimir_calls (ip_hash, created_at) where settled_at is null;
create index mimir_calls_ip_created_idx on public.mimir_calls (ip_hash, created_at);
create index mimir_calls_net_day_idx on public.mimir_calls (net_hash, day) where net_hash is not null;
create index mimir_calls_net_open_idx on public.mimir_calls (net_hash, created_at) where settled_at is null and net_hash is not null;

-- Refused reservations, so a refused install or address still counts toward its per-minute
-- rate. Kept only as long as the rate window.
create table public.mimir_refusals (
  install_id uuid not null references public.mimir_installs (id) on delete cascade,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index mimir_refusals_install_idx on public.mimir_refusals (install_id, created_at);
create index mimir_refusals_ip_idx on public.mimir_refusals (ip_hash, created_at);

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
  transcript jsonb not null check (octet_length(transcript::text) <= 262144),
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
alter table public.mimir_refusals enable row level security;
revoke all on public.mimir_limits, public.mimir_prices, public.mimir_secret, public.mimir_installs,
  public.mimir_calls, public.mimir_sessions, public.mimir_refusals from public, anon, authenticated;
-- the salt stays with the functions below, which run as their owner
revoke all on public.mimir_secret from service_role;
grant select, insert, update, delete on public.mimir_limits, public.mimir_prices, public.mimir_installs,
  public.mimir_calls, public.mimir_sessions, public.mimir_refusals to service_role;

-- The Melbourne day, which every cap counts in.
create function public.mimir_day() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Australia/Melbourne')::date;
$$;

-- The Melbourne midnight that started today.
create function public.mimir_day_start() returns timestamptz
language sql stable set search_path = '' as $$
  select public.mimir_day()::timestamp at time zone 'Australia/Melbourne';
$$;

-- HMAC of the address and the Melbourne day, so counts cannot be linked across days. An
-- IPv6 address counts by its /64, since one home or server line holds the whole /64. A call
-- without a readable address is refused rather than counted in a shared bucket.
create function public.mimir_addr(p_ip text) returns inet
language plpgsql immutable set search_path = '' as $$
declare
  v inet;
begin
  begin
    v := btrim(p_ip)::inet;
  exception when others then
    v := null;
  end;
  if v is null then
    raise exception 'no client address' using errcode = '22023', hint = 'no_ip';
  end if;
  if family(v) = 6 and host(v) ~ '^::ffff:[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' then
    v := substr(host(v), 8)::inet;
  end if;
  return v;
end;
$$;

create function public.mimir_hmac(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(extensions.hmac(convert_to(p_key || '|' || public.mimir_day()::text, 'UTF8'),
    (select salt from public.mimir_secret), 'sha256'), 'hex');
$$;

create function public.mimir_ip_hash(p_ip text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v inet := public.mimir_addr(p_ip);
begin
  return public.mimir_hmac(case when family(v) = 4 then host(v) else host(network(set_masklen(v, 64))) || '/64' end);
end;
$$;

-- The IPv6 /48 an address is in, hashed the same way, or null for IPv4: a site, a home
-- line or a tunnel gets a /48 or /56, so its /64s share these wider caps.
create function public.mimir_net_hash(p_ip text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v inet := public.mimir_addr(p_ip);
begin
  if family(v) = 4 then
    return null;
  end if;
  return public.mimir_hmac(host(network(set_masklen(v, 48))) || '/48');
end;
$$;

create function public.mimir_token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256'), 'hex');
$$;

-- A new install for p_edition, from a build holding the edition's registration key
-- p_key. Returns its id and token; only the token's hash is kept.
create function public.mimir_register(p_edition text, p_ip text, p_key text)
returns table (install_id uuid, token text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_lim public.mimir_limits;
  v_ip text := public.mimir_ip_hash(p_ip);
  v_net text := public.mimir_net_hash(p_ip);
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  select * into v_lim from public.mimir_limits where edition = p_edition;
  if not found then
    raise exception 'unknown edition' using errcode = '22023', hint = 'invalid';
  end if;
  if v_lim.register_key_hash is null
    or public.mimir_token_hash(p_key) not in (v_lim.register_key_hash, coalesce(v_lim.register_key_prev_hash, '')) then
    raise exception 'wrong registration key' using errcode = 'P0001', hint = 'register_key';
  end if;
  if not v_lim.enabled then
    raise exception 'mimir is paused' using errcode = 'P0001', hint = 'paused';
  end if;
  perform pg_advisory_xact_lock(hashtext('public.mimir_register'));
  if (select count(*) from public.mimir_installs where created_ip_hash = v_ip) >= v_lim.registers_per_ip_day then
    raise exception 'too many new installs from this address today' using errcode = 'P0001', hint = 'register_limit';
  end if;
  if v_net is not null and (select count(*) from public.mimir_installs where created_net_hash = v_net) >= v_lim.registers_per_net_day then
    raise exception 'too many new installs from this network today' using errcode = 'P0001', hint = 'register_limit';
  end if;
  if (select count(*) from public.mimir_installs i where i.edition = p_edition
      and i.created_at >= public.mimir_day_start()) >= v_lim.registers_per_day then
    raise exception 'too many new installs for this edition today' using errcode = 'P0001', hint = 'edition_register_limit';
  end if;
  -- installs that never made a call go after 7 days, and idle ones without shared sessions
  -- after 30 (their calls go with them), a few at a time; the app registers again on
  -- unknown_install
  delete from public.mimir_installs where id in (
    select i.id from public.mimir_installs i where i.last_call_at is null and i.created_at < now() - interval '7 days' limit 100);
  delete from public.mimir_installs where id in (
    select i.id from public.mimir_installs i where i.last_call_at < now() - interval '30 days'
      and not exists (select 1 from public.mimir_sessions s where s.install_id = i.id) limit 100);
  insert into public.mimir_installs (edition, token_hash, created_ip_hash, created_net_hash)
  values (p_edition, public.mimir_token_hash(v_token), v_ip, v_net)
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

-- An install's cap for today: the full cap until the edition has used half of its own,
-- then shrinking in step with what the edition has left, so heavy installs slow down
-- first and the edition is not used up at once.
create function public.mimir_install_cap(p_lim public.mimir_limits, p_edition_used bigint) returns bigint
language sql immutable set search_path = '' as $$
  select case
    when p_lim.edition_daily_micros = 0 then 0
    when p_edition_used * 2 <= p_lim.edition_daily_micros then p_lim.install_daily_micros
    else greatest(0, p_lim.install_daily_micros * 2 * (p_lim.edition_daily_micros - p_edition_used)
      / p_lim.edition_daily_micros)
  end::bigint;
$$;

-- Reserves the worst case of one call (p_input prompt tokens, all priced as cache writes,
-- p_output reply tokens and p_searches web searches at p_model's prices) for the install
-- holding p_token, from p_ip, against every cap. Raises with a hint naming the cap that
-- was hit.
create function public.mimir_reserve(p_token text, p_ip text, p_model text, p_input bigint, p_output bigint,
  p_searches integer) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inst public.mimir_installs;
  v_lim public.mimir_limits;
  v_day date := public.mimir_day();
  v_ip text := public.mimir_ip_hash(p_ip);
  v_net text := public.mimir_net_hash(p_ip);
  v_id uuid;
  v_edition_used bigint;
  v_install_used bigint;
  p_max_micros bigint;
begin
  if p_input is null or p_input < 0 or p_output is null or p_output < 0 or p_searches is null or p_searches < 0 then
    raise exception 'bad reservation' using errcode = '22023', hint = 'invalid';
  end if;
  p_max_micros := public.mimir_cost(p_model, 0, p_input, 0, p_output, p_searches);
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where edition = v_inst.edition;
  if not v_lim.enabled then
    raise exception 'mimir is paused' using errcode = 'P0001', hint = 'paused';
  end if;
  -- Rates first and outside the lock, so refused traffic does not queue behind it. Refused
  -- requests count too (mimir_refused).
  if (select count(*) from public.mimir_calls
      where install_id = v_inst.id and created_at > now() - interval '1 minute')
    + (select count(*) from public.mimir_refusals
      where install_id = v_inst.id and created_at > now() - interval '1 minute') >= v_lim.install_per_minute then
    raise exception 'too many requests' using errcode = 'P0001', hint = 'install_rate';
  end if;
  if (select count(*) from public.mimir_calls
      where ip_hash = v_ip and created_at > now() - interval '1 minute')
    + (select count(*) from public.mimir_refusals
      where ip_hash = v_ip and created_at > now() - interval '1 minute') >= v_lim.ip_per_minute then
    raise exception 'too many requests from this address' using errcode = 'P0001', hint = 'ip_rate';
  end if;
  -- One reservation at a time, so two calls cannot both slip under a cap (the IP cap spans
  -- editions, so the lock does too).
  perform pg_advisory_xact_lock(hashtext('public.mimir_reserve'));
  -- A call that never settled stops counting as in flight after call_open_seconds; its
  -- reservation still counts against the caps.
  if (select count(*) from public.mimir_calls where install_id = v_inst.id and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.install_in_flight then
    raise exception 'too many calls at once' using errcode = 'P0001', hint = 'install_busy';
  end if;
  if (select count(*) from public.mimir_calls where ip_hash = v_ip and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.ip_in_flight then
    raise exception 'too many calls at once from this address' using errcode = 'P0001', hint = 'ip_busy';
  end if;
  if v_net is not null and (select count(*) from public.mimir_calls where net_hash = v_net and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.net_in_flight then
    raise exception 'too many calls at once from this network' using errcode = 'P0001', hint = 'ip_busy';
  end if;
  if (select count(*) from public.mimir_calls where edition = v_inst.edition and settled_at is null
      and created_at > now() - make_interval(secs => v_lim.call_open_seconds)) >= v_lim.edition_in_flight then
    raise exception 'too many calls at once for this edition' using errcode = 'P0001', hint = 'edition_busy';
  end if;
  select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) into v_edition_used from public.mimir_calls
  where edition = v_inst.edition and day = v_day;
  select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) into v_install_used from public.mimir_calls
  where install_id = v_inst.id and day = v_day;
  if v_install_used + p_max_micros > v_lim.install_daily_micros then
    raise exception 'daily limit for this install reached' using errcode = 'P0001', hint = 'install_daily';
  end if;
  -- under its own cap but over the shrunken one: the edition's budget is what ran out
  if v_install_used + p_max_micros > public.mimir_install_cap(v_lim, v_edition_used) then
    raise exception 'daily limit for this edition reached' using errcode = 'P0001', hint = 'edition_daily';
  end if;
  if (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where ip_hash = v_ip and day = v_day) + p_max_micros > v_lim.ip_daily_micros then
    raise exception 'daily limit for this address reached' using errcode = 'P0001', hint = 'ip_daily';
  end if;
  if v_net is not null and (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) from public.mimir_calls
      where net_hash = v_net and day = v_day) + p_max_micros > v_lim.net_daily_micros then
    raise exception 'daily limit for this network reached' using errcode = 'P0001', hint = 'ip_daily';
  end if;
  if v_edition_used + p_max_micros > v_lim.edition_daily_micros then
    raise exception 'daily limit for this edition reached' using errcode = 'P0001', hint = 'edition_daily';
  end if;
  insert into public.mimir_calls (day, edition, install_id, ip_hash, net_hash, reserved_micros)
  values (v_day, v_inst.edition, v_inst.id, v_ip, v_net, p_max_micros)
  returning id into v_id;
  update public.mimir_installs set last_call_at = now() where id = v_inst.id;
  return v_id;
end;
$$;

-- Records a refused reservation for the install holding p_token, from p_ip, so it counts
-- toward the per-minute rates. Clears refusals past the one-minute window a few at a time.
create function public.mimir_refused(p_token text, p_ip text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select id into v_id from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    return;
  end if;
  insert into public.mimir_refusals (install_id, ip_hash) values (v_id, public.mimir_ip_hash(p_ip));
  delete from public.mimir_refusals where ctid in (
    select ctid from public.mimir_refusals where created_at < now() - interval '1 minute' limit 50);
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

-- Stores a shared session's latest turn for the install that made p_call, once the call
-- has settled and only once per call. Returns false, storing nothing, when the turn is
-- over 256 KB or the install has written its bytes for the day.
create function public.mimir_store_session(p_call uuid, p_session_key text, p_app_version text, p_model text,
  p_transcript jsonb) returns boolean
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
  -- one store at a time per install, so the day's sum below holds
  perform 1 from public.mimir_installs where id = v_call.install_id for update;
  select * into v_lim from public.mimir_limits where edition = v_call.edition;
  if v_bytes > 262144 or (select coalesce(sum(stored_bytes), 0) from public.mimir_calls
      where install_id = v_call.install_id and day = v_call.day) + v_bytes > v_lim.install_store_daily_bytes then
    update public.mimir_calls set stored_bytes = 0 where id = p_call;
    return false;
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
  v_edition_used bigint;
begin
  select * into v_inst from public.mimir_installs where token_hash = public.mimir_token_hash(p_token);
  if not found then
    raise exception 'unknown install' using errcode = 'P0001', hint = 'unknown_install';
  end if;
  select * into v_lim from public.mimir_limits where mimir_limits.edition = v_inst.edition;
  select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0) into v_edition_used from public.mimir_calls
  where mimir_calls.edition = v_inst.edition and mimir_calls.day = v_day;
  return query select v_inst.edition, v_day,
    (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0)::bigint from public.mimir_calls
      where install_id = v_inst.id and mimir_calls.day = v_day),
    public.mimir_install_cap(v_lim, v_edition_used),
    (select coalesce(sum(coalesce(cost_micros, reserved_micros)), 0)::bigint from public.mimir_calls
      where ip_hash = v_ip and mimir_calls.day = v_day),
    v_lim.ip_daily_micros,
    v_lim.enabled and v_edition_used < v_lim.edition_daily_micros;
end;
$$;

revoke execute on function public.mimir_day(), public.mimir_day_start(), public.mimir_ip_hash(text), public.mimir_token_hash(text),
  public.mimir_addr(text), public.mimir_hmac(text), public.mimir_net_hash(text),
  public.mimir_install_cap(public.mimir_limits, bigint), public.mimir_refused(text, text),
  public.mimir_register(text, text, text), public.mimir_reserve(text, text, text, bigint, bigint, integer),
  public.mimir_cost(text, bigint, bigint, bigint, bigint, integer),
  public.mimir_settle(uuid, text, bigint, bigint, bigint, bigint, integer),
  public.mimir_store_session(uuid, text, text, text, jsonb), public.mimir_forget(text),
  public.mimir_quota(text, text) from public, anon, authenticated;
grant execute on function public.mimir_register(text, text, text), public.mimir_reserve(text, text, text, bigint, bigint, integer),
  public.mimir_refused(text, text),
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
