# Bug intake

How crash and bug reports get from SlicerX to the Discord bug-reports channel. During pre-alpha, crash reports are always on and the first-run agreement says so.

## Flow

1. The app scrubs a report and calls `public.submit_bug_report(...)` on the production Supabase project, signed in or anonymously.
2. A poller on a maintainer machine polls for unposted rows with the service key, scrubs them again, and posts each one to the SlicerX server (guild 1555048815881355324), channel bug-reports (1556010155802628228).
3. The poller then sets `posted_at` and `discord_message_id`.

No endpoint on that machine is reachable from the internet.

## Table `public.bug_reports` (migration 0012)

| column | type | notes |
|---|---|---|
| id | uuid pk | gen_random_uuid() |
| created_at | timestamptz | now() |
| kind | text | `crash` or `manual` |
| install_id | uuid | random per install, kept in app prefs |
| user_id | uuid null | auth.uid() when signed in |
| app_version | text | up to 40 chars |
| commit | text | up to 40 chars |
| os | text | up to 80 chars |
| printer | text null | model and firmware, up to 120 chars |
| title | text | up to 200 chars, required |
| body | text | up to 20,000 chars: what happened, steps, expected |
| stack | text null | up to 50,000 chars |
| log_tail | text null | up to 200,000 chars |
| fingerprint | text null | hash of the normalized top stack frames, used to group repeats |
| posted_at | timestamptz null | set by the poller |
| discord_message_id | text null | set by the poller |

RLS is on. There are no policies for anon or authenticated, so clients can neither read nor write the table directly.

`public.submit_bug_report(p_kind, p_install_id, p_app_version, p_commit, p_os, p_printer, p_title, p_body, p_stack, p_log_tail, p_fingerprint) returns uuid` is security definer and granted to anon and authenticated. It checks the lengths and the kind, and allows at most 10 reports per install_id per hour and 200 per hour overall.

## Scrubbing

Both the app and the poller remove these before anything is stored or posted:

- tokens: `sxk_` tokens, JWTs, bearer headers, API keys
- printer access codes and serials
- IPv4 and IPv6 addresses
- emails
- home folder paths, replaced with `~`

## In the app

Code: `packages/app/src/bugs/`. `scrub.ts` is the scrubber and the fingerprint, `report.ts` fits a report to the columns, `outbox.ts` queues and sends, `reports.ts` catches crashes, `report-dialog.tsx` is Help, Report a bug.

- Crashes caught: `error` and `unhandledrejection` on the window, a workspace that crashed (its error boundary), and from the desktop shell Rust panics and a web view whose content process stopped or reloaded (`apps/desktop/src-tauri/src/crash.rs`). A panic hook writes a report file under the app data folder; the next launch sends it.
- Each crash is sent once per session per fingerprint, at most five a session.
- Reports wait in local storage (`slicerx.bugs.outbox.v1`, ten at most) when they cannot go now, and are sent at the next launch or when the connection comes back. A report the server refuses for a bad field is dropped; others are tried up to eight times.
- The fingerprint is SHA-256 of the error type and the top five stack frames, each normalized to `function (file)` with line numbers, origins, query strings and build hashes removed and Rust runtime frames skipped. A stack without frames falls back to the message with numbers and quoted values taken out.
- The log tail is the last 600 lines of the session: console output, plus the app's own notes (its start, workspace changes, slicing started, finished or failed, and each crash). The app writes little to the console, so without the notes most reports had no log. A copy is saved every few seconds and at once when the page goes away, so a report about a window that crashed or reloaded carries the log from before it.
- A page that unloads on its own terms (a reload by key, menu or script, or a navigation) notes it as its last line. With that line, the next start reports "The window was reloaded deliberately"; without it, "The window reloaded unexpectedly", since the page most likely stopped or hung. The two titles group apart.
- On Windows the web view's own browser keys (F5 and Ctrl+R reload, Ctrl+P, Alt+Left and the rest) are off in release builds, and the desktop page cancels F5 and Ctrl+R as well. Ctrl+R slices in the OrcaSlicer and PrusaSlicer looks, and elsewhere it used to reload the window.
- In a pre-alpha build (`release.stage` in the edition config) crash reports are locked on, and the first-run agreement says so. Elsewhere they follow the first-run setting.
- Developer mode adds two commands: "Developer: trigger a test crash" and, on the desktop, "Developer: trigger a test panic in the desktop shell".

## Editions

A white-label edition sends reports only to its own backend. With `bugs.upstream: true` in its edition config it also copies each crash report (`kind` crash only, scrubbed like any other, anonymous with no account token) to SlicerX through the same `submit_bug_report`, with `[<edition id>]` at the start of the title and `Edition: <id>` as the first line of the body. The copy is sent once and not retried if it fails. It needs no schema change and no new column. The endpoint is `UPSTREAM_REPORTS` in `packages/edition-config/src/links.ts`, which is `null` (nothing is sent) until SlicerX publishes it. The 200 an hour overall limit is shared with SlicerX's own reports.

## Discord post

- Each post has an embed with the kind, title, version and commit, OS and printer, plus the body.
- The stack and log go in an attached `.txt`.
- A repeat fingerprint becomes a reply in the first report's thread, not a new post.
