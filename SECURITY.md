# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Use GitHub private vulnerability reporting: on the repository page, open the
Security tab and choose "Report a vulnerability". This creates a private thread
visible only to the maintainers and you.

Include what you can: the affected version or commit, the platform, steps to
reproduce, and what an attacker gains. A proof of concept helps but is not
required.

## What to expect

- Acknowledgment within 3 business days.
- A first assessment (accepted, needs more information, or declined with
  reasons) within 10 business days.
- A fix target based on severity. Critical issues are patched and released as
  fast as a safe fix allows, usually within 14 days. Lower severities ride the
  next scheduled release.
- Credit in the release notes and the published advisory, unless you prefer to
  stay anonymous.

We ask for coordinated disclosure: please give us up to 90 days from your
report before publishing details, and we will tell you if we need less or more
time. We will not pursue legal action against people who test in good faith,
stay within the scope below, and do not access other people's data.

## Scope

In scope:

- The desktop, web, and mobile apps and the slicing core in this repository.
- Printer drivers in `packages/connect`, including credential handling for LAN
  and cloud printer connections.
- mimir's agent runtime (`packages/pilot`), including anything that lets a prompt or a model file
  reach a printer without the user's approval.
- The `.sx3mf` parser and the 3MF, STL, OBJ, and G-code importers. Memory safety
  bugs and parser crashes on crafted files are in scope.
- Supabase policies and edge functions defined under `supabase/`.

Out of scope: social engineering, denial of service by volume, reports from
automated scanners with no demonstrated impact, and issues in upstream
OrcaSlicer code that also affect upstream unmodified (report those upstream,
and tell us so we can pick up the fix).

## Supported versions

Until 1.0, only the latest release and `main` receive security fixes. After 1.0,
the latest minor release and the previous one are supported.

## Other contacts

Code of Conduct reports and other non-security matters go to the maintainers
through GitHub: open a private report as above and mark it "conduct". A
dedicated project mailbox will replace this before the repository goes public.
