-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- Crash and bug reports from the app (docs/bug-intake.md). Clients never touch the
-- table: they call submit_bug_report, which checks lengths and the kind and holds
-- each install to 10 reports an hour and everyone to 200 an hour. A poller on a
-- maintainer machine reads new rows with the service key, posts them to the Discord
-- bug-reports channel, and sets posted_at and discord_message_id.

create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('crash', 'manual')),
  install_id uuid not null,
  user_id uuid references auth.users (id) on delete set null,
  app_version text not null check (char_length(app_version) between 1 and 40),
  commit text not null check (char_length(commit) between 1 and 40),
  os text not null check (char_length(os) between 1 and 80),
  printer text check (char_length(printer) <= 120),
  title text not null check (char_length(btrim(title)) > 0 and char_length(title) <= 200),
  body text not null check (char_length(body) <= 20000),
  stack text check (char_length(stack) <= 50000),
  log_tail text check (char_length(log_tail) <= 200000),
  fingerprint text check (char_length(fingerprint) <= 128),
  posted_at timestamptz,
  discord_message_id text
);

create index bug_reports_install_recent_idx on public.bug_reports (install_id, created_at);
create index bug_reports_created_idx on public.bug_reports (created_at);
create index bug_reports_unposted_idx on public.bug_reports (created_at) where posted_at is null;
create index bug_reports_fingerprint_idx on public.bug_reports (fingerprint) where fingerprint is not null;

-- RLS on and no policies for anon or authenticated: no direct reads or writes.
alter table public.bug_reports enable row level security;
revoke all on public.bug_reports from public, anon, authenticated;
grant select, insert, update, delete on public.bug_reports to service_role;

create function public.submit_bug_report(
  p_kind text, p_install_id uuid, p_app_version text, p_commit text, p_os text, p_printer text,
  p_title text, p_body text, p_stack text, p_log_tail text, p_fingerprint text
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('crash', 'manual') then
    raise exception 'kind must be crash or manual' using errcode = '22023', hint = 'invalid';
  end if;
  if p_install_id is null then
    raise exception 'install_id is required' using errcode = '22023', hint = 'invalid';
  end if;
  if p_title is null or char_length(btrim(p_title)) = 0 then
    raise exception 'title is required' using errcode = '22023', hint = 'invalid';
  end if;
  if coalesce(char_length(p_app_version), 0) not between 1 and 40
    or coalesce(char_length(p_commit), 0) not between 1 and 40
    or coalesce(char_length(p_os), 0) not between 1 and 80
    or char_length(p_printer) > 120
    or char_length(p_title) > 200
    or p_body is null or char_length(p_body) > 20000
    or char_length(p_stack) > 50000
    or char_length(p_log_tail) > 200000
    or char_length(p_fingerprint) > 128 then
    raise exception 'a field is missing or too long' using errcode = '22001', hint = 'invalid';
  end if;

  -- One submit at a time, so two at once cannot both slip under a limit.
  perform pg_advisory_xact_lock(hashtext('public.submit_bug_report'));
  if (select count(*) from public.bug_reports
      where install_id = p_install_id and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many reports from this install; try again later' using errcode = 'P0001', hint = 'rate_limited';
  end if;
  if (select count(*) from public.bug_reports where created_at > now() - interval '1 hour') >= 200 then
    raise exception 'too many reports right now; try again later' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  insert into public.bug_reports (kind, install_id, user_id, app_version, commit, os, printer, title, body, stack, log_tail, fingerprint)
  values (p_kind, p_install_id, auth.uid(), p_app_version, p_commit, p_os, nullif(p_printer, ''), p_title, p_body,
          nullif(p_stack, ''), nullif(p_log_tail, ''), nullif(p_fingerprint, ''))
  returning id into v_id;
  return v_id;
end;
$$;

revoke execute on function public.submit_bug_report(text, uuid, text, text, text, text, text, text, text, text, text) from public;
grant execute on function public.submit_bug_report(text, uuid, text, text, text, text, text, text, text, text, text) to anon, authenticated, service_role;

-- Room for larger attachments later: private, no client policies, the service role only.
insert into storage.buckets (id, name, public, file_size_limit)
values ('bug-reports', 'bug-reports', false, 10485760);
