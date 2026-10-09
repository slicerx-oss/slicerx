# Self-hosted CI

Regression runs on our own machines, with no hosted CI. A bare repo takes pushes; its post-receive hook queues a run
of the pushed tip and starts a worker that runs one at a time. Each machine works in its own checkout under its CI
home (default `~/ci`), never in a developer's working tree.

## Tiers

- per-merge, on every push: `pnpm install`; vitest and `tsc` for the packages changed since the last green run and
  their dependents (`pnpm --filter "...[<green sha>]"`); `cargo test -p` for the crates whose files changed; the
  engine WASM size gate (`build-wasm.sh`, 1044 KB gzip) and the geom module when engine or geom code changed; the
  G-code goldens (`cargo test -p sx-core --test reference`), and clippy with `-D warnings` on the changed crates.
  With no green run yet, it tests everything.
- nightly, at 02:00 local: all vitest and `tsc`, the cargo workspace, the profile parity tests, pgTAP on the local
  Supabase stack where one runs, e2e (Playwright), the integrator sample, and the speed benchmark on the reference
  machine (`SX_CI_BENCH=1`).

A newer push replaces a run still waiting; a run in progress always finishes first. The nightly run has its own slot.
Every run holds the machine's heavy-work lock (`heavy.sh`, default `~/.slicerx-heavy.lock`, or `SX_HEAVY_LOCK`).
Release builds, kit builds and other heavy jobs on the same machine take it too (`scripts/ci/heavy.sh <command>`), so
a run never competes with a build for the CPU and timing tests stay honest. Waiters are served in arrival order, CI
jobs first (a self-hosted runner, or `SX_HEAVY_PRIORITY=ci`), and
`SX_HEAVY_WAIT=<seconds>` makes one give up (exit 75) after that long.

## Results

Each run writes `logs/<run>/`: `run.log`, one log per step, `steps.tsv`, `failures.txt` and `summary.txt`. The last
20 runs are kept. Only the summary (pass or fail, the failing steps and test names, the sha) leaves the machine,
through the command in `SX_CI_NOTIFY`. A green run records its sha in `state/last-green-<platform>`.

A failing test is rerun once; flaky and quarantined tests are tracked in `flaky.txt` and `quarantine.txt` (see "Flaky tests").

## Setup

    sh scripts/ci/install.sh        # ~/ci: bare repo, hook, bin/, ci.env to fill in
    git push <host>:ci/slicerx.git main

Remote runners (another machine, or WSL behind a Windows ssh login) are listed in `SX_CI_REMOTES`; `remote.sh` hands
them the commit as a git bundle over ssh and reports their summary. The nightly schedule is
`launchd.plist.example` on macOS; nothing is scheduled by `install.sh`.

Run by hand: `~/ci/bin/run.sh per-merge <sha>` or `nightly <sha>`.

## One lock for Windows and WSL

On a Windows machine that also builds or runs CI in WSL, both sides must take the same lock, or a Windows build and a
WSL run overlap. The lock goes on the Windows drive, named on each side:

- Git Bash: `SX_HEAVY_LOCK=C:\Users\<user>\.slicerx-heavy.lock` in the Windows user environment, or in the script
  that starts the job. The default `~/.slicerx-heavy.lock` is the same directory when `HOME` is the user profile.
- WSL: `SX_HEAVY_LOCK=/mnt/c/Users/<user>/.slicerx-heavy.lock` in the CI home's `ci.env`. When the environment does
  not set it, `heavy.sh` reads it from the `ci.env` of `$SX_CI_HOME`, or of the CI home whose `bin/` it runs from, so
  the worker, remote runs and a manual `<ci home>/bin/heavy.sh` agree. A `C:\` or `C:/` path works on either side.
  An existing `ci.env` needs the line added by hand; `install.sh` writes a new one only.

The holder's record (`<lock>/owner`) keeps the `pid <pid> since <time>: <command>` line and adds the holder's side
(`msys`, `wsl`, `linux` or `darwin`) and identity: its start time (from `/proc/<pid>/stat`, or `ps -o lstart` on
macOS), the boot id and distro on Linux and WSL, and the Windows pid and its start time in Git Bash. A waiter takes
the lock over only on evidence from the holder's own side:

- Same side: the pid is gone, or now has another start time (the pid was reused), or the boot id changed.
- A Git Bash holder, from WSL: `powershell.exe` (`Get-Process`) says its Windows pid is gone or started at another
  time. From Git Bash, its MSYS pid with the same Windows pid and start time is enough to call it alive.
- A WSL holder, from Git Bash or another distro: its distro is not running (`wsl.exe -l --running`), its boot id
  changed (`wsl --shutdown` ends every WSL process), or `/proc/<pid>/stat` in that distro shows no process or another
  start time. `wsl.exe` runs nothing in a distro that is not already running, so a check never starts WSL.
- Anything else counts as alive: the other side cannot be asked (no interop, a timeout), a start time cannot be read
  (an elevated holder), or the record comes from a side this one has no way to ask. The waiter keeps waiting.

From WSL, Windows programs run through `/init`, as WSL's binfmt entry would run them: a distro with systemd can lose
that entry, and then `powershell.exe` and `wsl.exe` fail when called directly.

Waiters take a ticket in `<lock>.queue` and only the oldest one tries the lock. A waiter refreshes its ticket on every
poll; a ticket left alone for two minutes belongs to a waiter that died and is dropped. The queue only orders the
waiters: `mkdir` alone decides who holds the lock, so an older `heavy.sh` that ignores the queue still never shares it.

Slots: a machine with room for more than one heavy job at a time names how many in `<lock>.slots` (one number, for
example `2`), and `SX_HEAVY_SLOTS` overrides it for one call. With no file the lock has one slot, as before. Slot 1 is
`<lock>` itself and slot n is `<lock>.n`, each with its own holder record, judged by the rules above. Of the waiters,
only as many of the oldest as there are free slots try one, so arrival order and CI first still hold. Pick the number
from the load two of the heaviest jobs put on the machine together (a merge-queue e2e job is the heaviest), not from
the core count. `heavy.sh --all <command>` waits for every slot and runs alone, for timing runs and benchmarks: it takes
the slots one by one as they free up, and while it waits, only the oldest ticket may take a slot, so it is never passed
over. A `heavy.sh` from before slots knows only `<lock>`, so it shares the machine with one slot-2 holder at most.

`scripts/ci/heavy-test.sh` tests all of this on a temporary lock: alone on any side, and with
`cross <distro> [<stopped distro>]` from Git Bash, Windows against WSL.

## Flaky tests

A failing test gets one rerun. Passed on the rerun: it is flaky. Failed again: it is a real failure, listed or not.
A red `main` blocks every merge and every release bump (`require-green.sh`, below).

Files, all in `scripts/ci/`:

- `flaky.txt`: tests that failed once and passed on the rerun. `name | owner | added | deadline | issue | why`. The
  deadline is at most one day after the date added. Past it, the entry counts as quarantined from the next day on
  (the run does not fail on it, and every report marks it OVERDUE) until someone fixes the test and deletes the line.
  It does not fail the run, so an unfixed flake never blocks `main` for a day-old deadline; the daily report is what
  keeps it visible.
- `quarantine.txt`: tests whose failures are counted, not failed on. `name | owner | added | issue | why`. Nothing is
  skipped silently: every entry has an owner, a date and a link to its issue.
- `flaky-check.sh`: `lint` fails on an entry without an owner, a valid date, a deadline within a day, or an issue link
  (`https://github.com/<org>/<repo>/issues/<n>`); `status <name>` prints quarantined, flaky or none; `report` lists both
  files with ages and deadlines; `retried <file>` is the pull request check below. A name is a substring of the test
  name as the run reports it (`path/to/file.test.ts > suite > test`, a cargo test path, or a Playwright title).
- `require-green.sh` and `required-checks.txt`: see "Release gate".

Machine runs (`run.sh`): when a step fails, only the failing tests run again, once. vitest reruns the failing files in
their packages, cargo test reruns the failing tests by exact name, Playwright reruns the failing spec files. A test
that passes is reported in the summary as flaky, tracked or UNTRACKED (not in `flaky.txt`), and does not fail the step;
a test that fails again fails the step. Anything the rerun cannot tell apart from a real failure (a failure it cannot
name, more failures than the 15 names kept, clippy, tsc, a build step, a compile error) stays a real failure.
Quarantined failures are not rerun. `flaky-lint` runs first in every run, and the summary lists overdue entries.

Pull requests (`ci.yml`, the `web` job): `pr-test.sh` runs each package's tests, vitest packages with `--retry=1`
and the reporter in `vitest-flaky-reporter.mjs`, which
annotates each test that passed only on a retry, and the next step fails the job unless `flaky.txt` or
`quarantine.txt` lists it, so a retry cannot hide a flake: the pull request that meets one adds the entry (owner, a
deadline a day out, an issue) or fixes the test. The e2e shards (`ci.yml`, `e2e-shard`) hold to the same rule with
Playwright's `--retries=1`: `playwright-results.mjs` reads the JSON report, a test that passed only on the retry must be
on either list, and a test that failed both times fails the job unless it counts as quarantined. The cargo job on pull
requests has no retry; the machine runs rerun it.

Adding an entry: open an issue for the test, add the line, run `bash scripts/ci/flaky-check.sh lint`. Fixing one:
fix the test and delete its line in the same change.

## Nightly shuffled run (proposal)

Not in place yet. Every run today takes the test files, and the tests in each file, in the same order. A test that only
passes because an earlier one left something behind (a module cache, a recorded reply cursor, store state) stays hidden
until someone moves it. A shuffled run finds those tests before they turn into flakes that are hard to read.

What it runs:

- A `vitest-shuffled` step in the nightly tier of `run.sh`, after the ordered `vitest` step and under the same heavy
  lock: every package's tests with `--sequence.shuffle --sequence.seed=<seed>`, which shuffles the files and the tests
  inside each file.
- The seed is the date of the run (`20261008` for 8 October 2026), printed at the top of its log, so a failing night
  can be run again exactly:

      cd packages/app && pnpm exec vitest run --sequence.shuffle --sequence.seed=20261008

- No rerun of a failing test. A rerun would pass in another order and hide exactly what the step looks for.

How it reports:

- The step's result goes in the nightly summary like any other step, with the seed and the failing test names.
- A test that fails shuffled and passed in the ordered step of the same night depends on its order. It gets an issue
  with the seed, like the ones in [#82](https://github.com/slicerx-oss/slicerx/issues/82).
- At first the step reports and does not fail the nightly run, and it does not block `main`. Once it has passed for two
  weeks of nights in a row, it fails the run like the other steps.

When it starts: after [#82](https://github.com/slicerx-oss/slicerx/issues/82) is fixed. On `main` today 4 to 15 of the
app's 213 test files fail per seed, all known and listed there, so a nightly run before that would only repeat them.

## Release gate

`require-green.sh <commit>` reads the commit's check-runs from GitHub (read only) and requires every check in
`required-checks.txt` to be success or skipped. A check still pending, or not yet reported, is waited for up to
`SX_GREEN_WAIT` seconds (default 600) and then counts as not green. `apps/desktop/release/publish.sh` runs it before it
builds or publishes anything. `SX_PUBLISH_CHECK_ONLY=1 publish.sh ...` (or `require-green.sh --dry-run <commit>`) only
reports. `SX_PUBLISH_ALLOW_RED=1` lets a red commit through with a loud warning: for an owner-approved emergency only.
Keep `required-checks.txt` in step with the jobs in `ci.yml`.
