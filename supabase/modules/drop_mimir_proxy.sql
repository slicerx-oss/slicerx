-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Removes mimir's cloud model accounting and saved chats (migrations/0020_mimir_proxy.sql, 0024_mimir_saved_chats.sql).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mimir-expire-saved';
  end if;
end;
$$;
drop function if exists public.mimir_reader_prompt(text);
drop function if exists public.mimir_expire_saved(integer);
drop function if exists public.mimir_save_chat(uuid, boolean, text, text, text, text, jsonb, jsonb);
drop function if exists public.mimir_reader_session(uuid, text);
drop function if exists public.mimir_reader_sessions(timestamptz, integer);
drop function if exists public.mimir_reader_edition();
drop function if exists public.mimir_quota(text, text);
drop function if exists public.mimir_forget(text);
drop function if exists public.mimir_store_session(uuid, text, text, text, jsonb);
drop function if exists public.mimir_refused(text, text);
drop function if exists public.mimir_settle(uuid, text, bigint, bigint, bigint, bigint, integer);
drop function if exists public.mimir_cost(text, bigint, bigint, bigint, bigint, integer);
drop function if exists public.mimir_reserve(text, text, text, bigint, bigint, integer);
drop function if exists public.mimir_install_cap(public.mimir_limits, bigint);
drop function if exists public.mimir_register(text, text, text);
drop function if exists public.mimir_token_hash(text);
drop function if exists public.mimir_net_hash(text);
drop function if exists public.mimir_ip_hash(text);
drop function if exists public.mimir_hmac(text);
drop function if exists public.mimir_addr(text);
drop function if exists public.mimir_day_start();
drop function if exists public.mimir_day();
drop table if exists public.mimir_prompts, public.mimir_refusals, public.mimir_sessions, public.mimir_calls, public.mimir_installs, public.mimir_secret,
  public.mimir_prices, public.mimir_limits;
revoke usage on schema public from mimir_session_reader;
