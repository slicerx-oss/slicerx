-- SPDX-License-Identifier: Apache-2.0
-- Copyright (C) 2026 The SlicerX contributors
-- External review: a reviewer outside the app (a chat bot the owner presses
-- buttons in) approves or sends back uploads without holding a key that can do
-- anything else.
--
-- The service signs in as the database role listing_reviewer. It is created
-- NOLOGIN with no table privileges and may execute only the four
-- external_review functions below. Turning it on is a deployment step, never a
-- migration: alter role listing_reviewer with login password '<secret>'. The
-- kill switch: alter role listing_reviewer nologin.
--
-- Each decision names its actor (such as discord:<user id>), which must be in
-- external_reviewers, a table only the service role fills. Decisions run the
-- same checks as approve_listing and reject_listing (still waiting, every
-- waiting file scanned clean, a reason for a send back) and write the audit log
-- with actor_id null and the actor in detail.actor.
--
-- approve_listing and reject_listing are rewritten to share that logic through
-- review_approve and review_send_back; what they do is unchanged.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'listing_reviewer') then
    create role listing_reviewer nologin noinherit connection limit 2;
  end if;
end;
$$;
alter role listing_reviewer set statement_timeout = '10s';
alter role listing_reviewer set search_path = '';
grant usage on schema public to listing_reviewer;

-- Who may decide through listing_reviewer. Filled by the service role.
create table public.external_reviewers (
  actor text primary key check (actor ~ '^[a-z]{2,20}:[A-Za-z0-9_.-]{1,64}$'),
  note text check (char_length(note) <= 200),
  added_at timestamptz not null default now()
);
alter table public.external_reviewers enable row level security;
-- No policies: clients can neither read nor write it.
revoke all on public.external_reviewers from anon, authenticated, public;
grant select, insert, update, delete on public.external_reviewers to service_role;

-- The message the reviewer posted for a listing's current review round, so a
-- restart never posts twice. closed_at is set once the message shows the decision;
-- a later round (a resubmission, a new version) gets a new message.
create table public.external_review_posts (
  listing_id uuid primary key references public.listings (id) on delete cascade,
  message_id text not null check (char_length(message_id) between 1 and 100),
  posted_at timestamptz not null default now(),
  closed_at timestamptz
);
alter table public.external_review_posts enable row level security;
revoke all on public.external_review_posts from anon, authenticated, public;
grant select, insert, update, delete on public.external_review_posts to service_role;

-- Shared review logic --------------------------------------------------------------
-- Not callable by clients. The caller checks who may review; p_detail is added to
-- the audit row.

create function public.review_approve(p_listing uuid, p_note text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.listings%rowtype;
begin
  select * into l from public.listings where id = p_listing for update;
  if not found then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;
  if l.status not in ('pending', 'approved') then
    raise exception 'a % listing is not waiting for review', l.status using errcode = 'P0001';
  end if;
  if public.is_creator_owner(l.creator_id) and not public.is_owner() then
    raise exception 'another staff member has to review your own upload' using errcode = '42501';
  end if;
  -- A pending listing needs a file that was not rejected. An approved one needs a waiting version.
  if not exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status <> 'rejected')
     or (l.status = 'approved' and not exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending')) then
    raise exception 'nothing is waiting for review' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.listing_versions v
    where v.listing_id = l.id and v.review_status = 'pending' and v.scan_status <> 'clean'
  ) then
    raise exception 'a file has not passed the upload scan yet' using errcode = 'P0001';
  end if;
  update public.listing_versions set review_status = 'approved' where listing_id = l.id and review_status = 'pending';
  update public.listings set
    status = 'approved',
    review_note = null,
    reviewed_by = (select auth.uid()),
    reviewed_at = now(),
    published_at = coalesce(published_at, now())
  where id = l.id;
  perform public.audit('approve', 'listing', l.id, p_note, jsonb_build_object('title', l.title) || coalesce(p_detail, '{}'::jsonb));
end;
$$;

create function public.review_send_back(p_listing uuid, p_reason text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  l public.listings%rowtype;
  reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(reason) < 3 then
    raise exception 'give the creator a reason' using errcode = '23514';
  end if;
  select * into l from public.listings where id = p_listing for update;
  if not found then
    raise exception 'no such listing' using errcode = 'P0002';
  end if;
  if l.status not in ('pending', 'approved') then
    raise exception 'a % listing is not waiting for review', l.status using errcode = 'P0001';
  end if;
  if public.is_creator_owner(l.creator_id) and not public.is_owner() then
    raise exception 'another staff member has to review your own upload' using errcode = '42501';
  end if;
  update public.listing_versions set review_status = 'rejected' where listing_id = l.id and review_status = 'pending';
  if l.status = 'pending' then
    update public.listings set status = 'rejected', review_note = reason, reviewed_by = (select auth.uid()), reviewed_at = now()
    where id = l.id;
  end if;
  perform public.audit('reject', 'listing', l.id, reason,
    jsonb_build_object('title', l.title, 'was', l.status) || coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke execute on function public.review_approve(uuid, text, jsonb), public.review_send_back(uuid, text, jsonb)
from anon, authenticated, service_role, public;

create or replace function public.approve_listing(p_listing uuid, p_note text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.can_moderate() then
    raise exception 'you cannot approve uploads in the current moderation mode' using errcode = '42501';
  end if;
  perform public.review_approve(p_listing, p_note);
end;
$$;

create or replace function public.reject_listing(p_listing uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.can_moderate() then
    raise exception 'you cannot reject uploads in the current moderation mode' using errcode = '42501';
  end if;
  perform public.review_send_back(p_listing, p_reason);
end;
$$;

-- External review --------------------------------------------------------------------

-- What the reviewer shows. One row per listing that is waiting and ready (every
-- waiting file scanned clean), plus one per listing whose open message still
-- shows buttons although it was decided elsewhere (kind 'decided'), so the
-- reviewer can update that message. message_id is the open message, if any.
create function public.external_review_queue()
returns table (
  listing_id uuid, kind text, slug text, title text, status text, cover_url text, license text, tags text[],
  creator_handle text, creator_name text, is_qa boolean, uploader_banned boolean, submitted_at timestamptz,
  versions jsonb, message_id text, review_note text, reviewed_at timestamptz, decided_by text
)
language sql stable security definer set search_path = '' as $$
  with waiting as (
    select l.id from public.listings l
    where (l.status = 'pending'
        or (l.status = 'approved' and exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending')))
      and exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status <> 'rejected')
      and not exists (select 1 from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending' and v.scan_status <> 'clean')
  ),
  items as (
    select w.id, 'waiting'::text as state from waiting w
    union all
    select p.listing_id, 'decided' from public.external_review_posts p
    where p.closed_at is null and p.listing_id not in (select id from waiting)
  )
  select
    l.id,
    case when r.state = 'decided' then 'decided' when l.status = 'approved' then 'version' else 'new' end,
    l.slug, l.title, l.status, l.cover_url, l.license, l.tags,
    c.handle, c.display_name,
    exists (select 1 from public.qa_accounts q where q.user_id = c.owner_id),
    pr.banned_at is not null,
    coalesce((select max(v.created_at) from public.listing_versions v where v.listing_id = l.id and v.review_status = 'pending'), l.created_at),
    -- The waiting files. A decided row needs none: its message already shows them.
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'version', v.version, 'format', v.format, 'size_bytes', v.size_bytes, 'scanned_at', v.scanned_at,
        'scan_report', v.scan_report,
        'parts', (select count(*) from public.listing_files f where f.version_id = v.id and f.role = 'model'),
        'plates', (select count(*) from public.listing_files f where f.version_id = v.id and f.role = 'plate')
      ) order by v.created_at)
      from public.listing_versions v
      where r.state = 'waiting' and v.listing_id = l.id and v.review_status = 'pending'
    ), '[]'::jsonb),
    (select p.message_id from public.external_review_posts p where p.listing_id = l.id and p.closed_at is null),
    l.review_note,
    l.reviewed_at,
    case when r.state = 'decided' then (
      select coalesce(a.detail ->> 'actor', 'profile:' || ap.handle, 'automatic')
      from public.audit_log a left join public.profiles ap on ap.id = a.actor_id
      where a.target_kind = 'listing' and a.target_id = l.id and a.action in ('approve', 'reject', 'remove', 'auto_approve')
      order by a.at desc, a.id desc limit 1
    ) end
  from items r
  join public.listings l on l.id = r.id
  join public.creators c on c.id = l.creator_id
  join public.profiles pr on pr.id = c.owner_id
  order by 13;
$$;

-- Approves or sends back a listing for an actor in external_reviewers. Returns
-- the listing's status afterwards.
create function public.review_listing_external(p_listing uuid, p_decision text, p_note text, p_actor text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  detail jsonb := jsonb_build_object('actor', p_actor, 'via', 'external_review');
begin
  if p_decision is null or p_decision not in ('approve', 'send_back') then
    raise exception 'decision must be approve or send_back' using errcode = '23514';
  end if;
  if not exists (select 1 from public.external_reviewers r where r.actor = p_actor) then
    raise exception 'this reviewer is not allowed' using errcode = '42501';
  end if;
  -- Decide as nobody signed in, whatever request settings the session carries.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if p_decision = 'approve' then
    perform public.review_approve(p_listing, nullif(btrim(coalesce(p_note, '')), ''), detail);
  else
    perform public.review_send_back(p_listing, p_note, detail);
  end if;
  return (select status from public.listings where id = p_listing);
end;
$$;

-- Records the message posted for a listing's review round.
create function public.external_review_posted(p_listing uuid, p_message_id text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.external_review_posts (listing_id, message_id) values (p_listing, p_message_id)
  on conflict (listing_id) do update set message_id = excluded.message_id, posted_at = now(), closed_at = null;
$$;

-- Marks a listing's message as showing the decision.
create function public.external_review_closed(p_listing uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update public.external_review_posts set closed_at = now() where listing_id = p_listing and closed_at is null;
$$;

revoke execute on function
  public.external_review_queue(), public.review_listing_external(uuid, text, text, text),
  public.external_review_posted(uuid, text), public.external_review_closed(uuid)
from anon, authenticated, service_role, public;
grant execute on function
  public.external_review_queue(), public.review_listing_external(uuid, text, text, text),
  public.external_review_posted(uuid, text), public.external_review_closed(uuid)
to listing_reviewer;
