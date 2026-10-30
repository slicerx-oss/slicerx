# Self-hosted CI

Regression runs on our own machines, with no hosted CI. A bare repo takes pushes; its post-receive hook queues a run
of the pushed tip and starts a worker that runs one at a time. Each machine works in its own checkout under its CI
home (default `~/ci`), never in a developer's working tree.

## Tiers

- per-merge, on every push: `pnpm install`; vitest and `tsc` for the packages changed since the last green run and
  their dependents (`pnpm --filter "...[<green sha>]"`); `cargo test -p` for the crates whose files changed; the
  engine WASM size gate (`build-wasm.sh`, 1056 KB gzip) and the geom module when engine or geom code changed; the
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

A failing test is rerun once; flaky and quarantined tests are tracked as one file per entry in `flaky.d/` and `quarantine.d/` (see "Flaky tests").

## GitHub Actions

The hosted workflow (`.github/workflows/ci.yml`) runs beside this. Pull requests and the merge queue share one pool of
hosted runners, so a pull request runs only the quick checks and, when it touches the app, one browser smoke job
(`e2e-smoke`). The browser suite's full matrix (`e2e-shard`, twelve desktop and four phone shards) and the @gpu lane
run in the merge queue. A pull request labeled `full-ci`, or one that changes the browser suite's own harness, runs
the suite on half the shards (six desktop, two phone), every test still included. The required check names do not
change: `e2e` and `rust-tests` pass when what they gather was not needed. When to add the label is in CONTRIBUTING.md,
"What CI runs".

A label event starts its own run (the concurrency comment in `ci.yml`). A run for a label that adds nothing (any label
but `full-ci`, or `full-ci` already on the pull request when it opened) skips every job except `rust`, which starts
and skips its steps, so its required matrix name `rust (ubuntu-latest)` still reports, as passed, and the gate
`rust (windows-latest)`, which passes at once.

The B-rep kernel build (`packages/brep`, with SMLib) runs only when a change touches what it reads (`brep_paths` in the
detect job). On Linux it is the job `brep-linux`, and the gate `brep (ubuntu-latest)` gathers it: the gate is a
required check, so the merge queue waits for it, and it passes at once when the path filter skipped the build. It fails
when detect failed or when the build was wanted and did not pass. The macOS and Windows builds (the job `brep`) are
advisory: no required check waits on them, so the Windows build (up to an hour on a cold cache) stays out of the queue,
and a failure there adds a warning to the run saying so. `scripts/ci/brep-gate.test.mjs` checks this graph and runs
the gate's script.

## Rust test parts

A push to main runs the whole Rust test suite on macOS and Windows, and a pull request labeled `full-ci` runs it on
Windows. Each system is a set of parts that run side by side (`rust-macos-parts`: 2, `rust-windows-parts`: 3), and the
jobs named `rust (macos-latest)` and `rust (windows-latest)` gather them: they fail when any part failed, timed out or
never ran, and they keep the names `required-checks.txt` lists. A part runs `node scripts/ci/windows-rust-tests.mjs
<part> --of <parts>`. The script reads cargo metadata, so a new sx-core test file is picked up with no list to edit:
the items are the workspace crates other than sx-core with its unit tests and doctests (always part 1, with fmt,
clippy and the sx-cloud build) and one item per sx-core test file, handed out heaviest first to the lightest part. The
weights are seconds in `rust-part-weights.json`; a file without one counts as 5 s and is named in a warning. Each part
writes a table of its test binaries and their times to the job summary, which is where to read new weights from. Only
part 1 saves the cache, so parts that end together do not race for the key.

On hosted Linux (a pull request, or the queue with `RUST_TESTS_ON_PC` set to `false`) sx-core's other test files are
split the same way into `core-a` and `core-b`, and the desktop shell's clippy and tests are the `desktop` part, with
`apt-desktop-libs.sh` installing its libraries (one `apt-get update`, then up to three `apt-get install` tries of
150 s each). The `core` part on the self-hosted runners stays whole.

`node scripts/ci/rust-part-coverage.mjs` proves every test file of every package is in exactly one part and that the
matrices in `ci.yml` have as many parts as the split uses. The `rust` job runs it on every pull request, so a change to
the test layout or to a part count fails there first.

## Setup

    sh scripts/ci/install.sh        # ~/ci: bare repo, hook, bin/, ci.env to fill in
    git push <host>:ci/slicerx.git main

Remote runners (another machine, or WSL behind a Windows ssh login) are listed in `SX_CI_REMOTES`; `remote.sh` hands
them the commit as a git bundle over ssh and reports their summary. The nightly schedule is
`launchd.plist.example` on macOS; nothing is scheduled by `install.sh`.

Run by hand: `~/ci/bin/run.sh per-merge <sha>` or `nightly <sha>`.

## Disk

A cargo target per worktree costs several GB each, and a machine that hosts agents ends up with dozens of them. Name
one shared target beside the lock and every command run under `heavy.sh` builds there:

    echo ~/builds/target-shared > ~/.slicerx-heavy.lock.target-dir

A `CARGO_TARGET_DIR` the caller sets still wins, and `sccache` becomes the `RUSTC_WRAPPER` when it is installed.

A machine that shares its cores with other work can cap cargo and test threads under the lock the same way:

    echo 4 > ~/.slicerx-heavy.lock.jobs

`CARGO_BUILD_JOBS` and `RUST_TEST_THREADS` that the caller sets still win. Without the file nothing is capped.

The self-hosted Rust test jobs in `ci.yml` keep one target per runner (`$HOME/target/<runner name>`) and build with
`CARGO_INCREMENTAL=0`: a test build never rebuilds in place, and `debug/incremental` had grown to 43 GB on one runner.

Temp dirs: tests and tools leave dirs in the temp folder that nothing else removes. `scripts/janitor-mac.sh` (macOS,
Linux, WSL) and `scripts/janitor-win.ps1` (Windows) remove these, and only these, once nothing has written to them for
two hours:

- `<21-character id>/` holding only `ssr/` and `client/`: Vitest's own temp dir (below)
- `sx-e2e-native-*`: the browser suite's native slicer host, when the pid in its `owner.pid` is gone
- `slicerx-mcp-test-*`, `slicerx-mcp-fn-*`, `sx-hub-test-*`, `sx-cli-*`, `sx-starters-*`, `sx-updater-e2e-*`: Node and Rust tests
- `sx-sign*`: the Mac signing scripts' stage and notarization dirs
- `playwright-artifacts-*`: Playwright
- with `janitor-mac.sh` only: `<target dir>/*/debug/incremental` (default `$HOME/target`, `--target-dir` for others)
  while no `cargo`, `rustc` or `Runner.Worker` runs

Both look at depth 1 of the temp folders only, skip anything that holds a `.git`, and make a dry run by default: each
dir with its size and age, a total, and the free space before and after. `--execute` (`-Execute`) deletes, and
`--below-gb N` (`-BelowGB N`) does nothing while more than N GB are free. `janitor-win.ps1` also reads the GPU
runners' temp folders when it runs elevated, measures with `robocopy /L`, and estimates the size of a name with
thousands of dirs from a sample (`-MeasureMax`). They run with `--execute` at the start of every nightly run
(`run.sh`; `SX_CI_JANITOR=0` turns it off, `SX_CI_JANITOR_ARGS` adds options) and in an `always()` step at the end of
the self-hosted jobs in `ci.yml`. The GPU lane also gives each job a temp folder of its own under `RUNNER_TEMP` and
removes it at the end, since Windows ends the native host with a hard kill and its `SIGTERM` cleanup never runs there.

Vitest 5.0.2 makes `<tmpdir>/<21-character id>/{ssr,client}` for its core module runner on every run and never
removes it: 995 dirs (27.9 GB) piled up on one CI machine and 4,238 (73.7 GB) on another.
`patches/vitest@5.0.2.patch` (`patchedDependencies` in `pnpm-workspace.yaml`) removes it when Vitest closes. A Vitest
upgrade has to move the patch to the new version, or drop it once Vitest removes the dir itself.

When a PR merges, remove its worktree if it is clean (`git worktree remove <dir>`) and delete the local branch. A dirty
one is left for its owner. Build outputs that are kept (release and tester DMGs, logs) go to an archive machine on a
weekly schedule: tar each one, check the byte count on the far side, then delete the local copy.

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
- A holder past its max hold (below) by twice its grace and 5 minutes more is taken over whether or not it can be
  proved dead: its own `heavy.sh` should have stopped it by then. The history logs it as a `stale holder`, and the
  process is left running.

Waiters judge the holders while they wait, and a holder judges every other slot once right after it takes its own,
by the same rules. A job cancelled past its traps leaves a dead holder behind, and with a free slot beside it no one
waits for that one, so it would stay until the slots filled up. The judgement runs in the background, on none of the
caller's streams (the history logs what it clears), so the take is not slowed and nothing waits for it to end. It
never touches the holder's own slots, and like a waiter's it clears a slot only while it still holds the record that
was judged.

From WSL, Windows programs run through `/init`, as WSL's binfmt entry would run them: a distro with systemd can lose
that entry, and then `powershell.exe` and `wsl.exe` fail when called directly.

Waiters take a ticket in `<lock>.queue`, named `<class>-<seconds>-<sequence>-<side>-<pid>`, so CI tickets sort first
and tickets from the same second keep their order. Admission is decided under a short `mkdir` gate (`<lock>.gate`,
held only for the decision and cleared when older than 30 s): the deciding waiter walks the queue from its head, hands
the free slots to the tickets in order, and takes one only if one is left for its own ticket, so several slots freeing
at once never let in more waiters than there are slots, and back-to-back holds by others never pass a waiter over. A
waiter refreshes its ticket between its checks; a ticket left alone for two minutes belongs to a waiter that died and
is dropped. `mkdir` alone still decides who holds a slot, so an older `heavy.sh` never shares one, but a copy from
before the ticket format sorts last and can wait a long time: every machine should run the same copy, and a waiter
that sees an old ticket says so once.

Max hold: no holder keeps the lock forever. `SX_HEAVY_MAX_HOLD` (the number in `<lock>.max-hold`, default 7200 for
`--e2e` and `--gpu` and no limit for the other modes, 0 for none) is the longest the command may run under the lock.
Past it, `heavy.sh` sends TERM to the command and its children (Git Bash: `taskkill /T`), KILL after
`SX_HEAVY_KILL_GRACE` seconds (default 60), and exits 124. A command that outlives KILL too (a browser stuck in a GPU
driver) is left running, and after the grace once more its slots are freed so the queue moves on. The record says
`hold <seconds> grace <seconds>`, so waiters on every side know when a holder that cannot be asked is stale; a record
from an older `heavy.sh` gets this machine's max hold for its class. A holder whose slot was taken over leaves it to
its new holder when it ends.

Promotion: a waiter that is not a CI job (and not `--all`) is queued as one once its ticket is
`SX_HEAVY_PROMOTE_AFTER` seconds old (the number in `<lock>.promote-after`, default 1800, 0 for never): its ticket is
renamed from class 1 to class 0 and sorts by its time with the CI tickets, so CI jobs that queued after it no longer
go first and two CI runs per merge cannot starve an agent's run.

Each take and release is also a line in `history.log` beside the lock (time, mode, slots, side and pid, user, label,
session, rc and hold time on release, command), as are take-overs (`clear`, with `dead holder` or `stale holder`),
give-ups, promotions and the max hold's `timeout`, `kill` and `abandon`, renamed to `history.log.1` at 1 MB. `SX_HEAVY_HISTORY` picks another
file, and an empty value turns it off. `SX_HEAVY_LABEL` names a hold in its record and in the log (for example
`"nightly bench"`), so a hold that is only a `sleep` still says whose it is; `SX_HEAVY_SESSION` adds a session id.

Slots: a machine with room for more than one heavy job at a time names how many in `<lock>.slots` (one number, for
example `2`), and `SX_HEAVY_SLOTS` overrides it for one call. With no file the lock has one slot, as before. Slot 1 is
`<lock>` itself and slot n is `<lock>.n`, each with its own holder record, judged by the rules above. Of the waiters,
only as many of the oldest as there are free slots try one, so arrival order and CI first still hold. Pick the number
from the load two of the heaviest jobs put on the machine together (a merge-queue e2e job is the heaviest), not from
the core count. `heavy.sh --all <command>` waits for every slot and runs alone, for timing runs and benchmarks: it takes
the slots one by one as they free up, and while it waits, only the oldest ticket may take a slot, so it is never passed
over. A `--all` waiter that is not a CI job gives its slots back, and takes none, while any CI ticket waits, so CI never
waits for a manual `--all` run to collect the machine; it goes once no CI ticket is waiting. A CI `--all` waiter keeps
its slots. A `heavy.sh` from before slots knows only `<lock>`, so it shares the machine with one slot-2 holder at most.

`heavy.sh --e2e <command>` marks a browser suite run (its record says `class e2e`): while one holds a slot, no other
`--e2e` waiter takes one, because two suites drawing software WebGL overload a machine (two 5-worker desktop runs took
a 24-thread machine to a load of 80). Waiting `--e2e` tickets do not count toward the positions of the waiters behind
them, so builds and other jobs still use the free slots.

`heavy.sh --gpu <command>` marks a GPU-drawn browser suite run (`class gpu`). It takes one of the GPU slots
(`<lock>.gpu.1` and on; how many is the number in `<lock>.gpu-slots`, default 1, or `SX_HEAVY_GPU_SLOTS`), never a
plain slot, so several GPU runners' suites run side by side while agents keep the plain slots. A `--gpu` waiter waits
while an `--e2e` or `--all` run holds or is queued ahead of it in queue order (CI first, then arrival), and an `--e2e`
or `--all` waiter waits until no `--gpu` run holds or is handed a GPU slot ahead of it. The slots a `--all` waiter has
collected while it still waits do not count as a run: a `--gpu` ticket ahead of it in the queue still gets its GPU
slot, and the `--all` run starts after that one ends. The GPU lane runs its `@gpu` specs under `--gpu` and its frame timing specs (`@gpu-timing`) after
them under `--e2e`, alone.

A `--gpu` run also slices on the CPU in several browsers at once, and fails beside an engine test suite (spawn
errors, closed browsers and test timeouts while cargo held the other slots). `heavy.sh --class engine <command>` marks
a plain hold as one (its record says `class engine`). CI's Rust test steps set it, and a plain hold whose command runs
`cargo` (a word of the command, also inside a `sh -c` script) is one without the flag, whoever runs it. A script that
runs cargo inside should pass `--class engine` itself. A `--gpu` run gets the machine to itself: it starts only while
at most `SX_HEAVY_GPU_ENGINE` engine holds run (the number in `<lock>.gpu-engine`, default 0), and while one holds,
engine waiters keep to that many slots. A `--gpu` ticket anywhere in the queue that only the engine holds keep out is
about to be handed a GPU slot, and engine waiters, CI or manual, ahead of it or behind it, wait for it too. Other plain
jobs are not limited.

No engine waiter starves: once its ticket is `SX_HEAVY_ENGINE_STARVE` seconds old (the number in
`<lock>.engine-starve`, default 240) it takes the next turn. While it waits with a plain slot free for it, no `--gpu`
ticket is handed a GPU slot; it starts as soon as the `--gpu` runs end, or at twice that age beside a `--gpu` run that
still holds. So the GPU lane adds at most 480 s to an engine hold's wait, well inside CI's `SX_HEAVY_WAIT` of 1200 s
for the Rust steps.

A manual `--e2e` waiter that cannot run yet (a `--gpu` run or another `--e2e` run blocks it) gives its turn back: it
keeps its place in the queue but holds nobody back, so the waiters behind it use what is free. Once its ticket is
`SX_HEAVY_RESERVE_AFTER` seconds old (the number in `<lock>.reserve-after`, default 900) it keeps its turn as a CI
waiter does from the start: the slot it needs is kept free for it, and the `--gpu` waiters behind it wait, so it is
never starved. The engine wait limit and this setting are read again at every decision. Each time what blocks a waiter changes, it
prints one `heavy.sh: waiting:` line naming the holders or tickets in its way.

`scripts/ci/heavy-test.sh` tests all of this on a temporary lock: alone on any side, and with
`cross <distro> [<stopped distro>]` from Git Bash, Windows against WSL.

## Flaky tests

A failing test gets one rerun. Passed on the rerun: it is flaky. Failed again: it is a real failure, listed or not.
A red `main` blocks every merge and every release bump (`require-green.sh`, below).

Files, all in `scripts/ci/`:

- `flaky.d/`: tests that failed once and passed on the rerun, one file per test, named `<issue>-<slug>.txt` (the issue
  number from its link and a few lowercase words, so two tests on one issue get two files). The file holds one line,
  `name | owner | added | deadline | issue | why`. The deadline is at most one day after the date added. Past it, the
  entry counts as quarantined from the next day on (the run does not fail on it, and every report marks it OVERDUE)
  until someone fixes the test and deletes the file. It does not fail the run, so an unfixed flake never blocks `main`
  for a day-old deadline; the daily report is what keeps it visible. One file per entry means adding or removing an
  entry never touches another's lines, so two pull requests listing different tests do not conflict.
- `quarantine.d/`: tests whose failures are counted, not failed on, one file per test as above, holding
  `name | owner | added | issue | why`. Nothing is skipped silently: every entry has an owner, a date and a link to its
  issue. An entry in either folder added more than 14 days ago (`SX_QUARANTINE_MAX_DAYS`) is stale: `lint` prints a
  `::warning` naming the entry, its age and its issue on every run, and `report` marks it STALE, so a quarantine never
  turns into a permanent skip. A stale entry does not fail the run.
- `flaky-check.sh`: `lint` fails on an entry without an owner, a valid date, a deadline within a day, or an issue link
  (`https://github.com/<org>/<repo>/issues/<n>`), on a file with more or less than one entry line, a file not named for
  its issue, a test listed twice, or a leftover `flaky.txt` or `quarantine.txt`; `status <name>` prints quarantined,
  flaky or none; `report` lists both folders with ages and deadlines; `retried <file>` and `failed <file>` are the pull
  request checks below (`failed` passes only when every test in the file counts as quarantined, and always fails on a
  line starting with `!`, an error outside any test). A name is a substring of the test
  name as the run reports it (`path/to/file.test.ts > suite > test`, a cargo test path, or a Playwright title).
- `cargo-retry.sh <cargo test arguments>`: `cargo test --no-fail-fast` with the one rerun by exact name below, for a
  CI job; it appends the tests that passed only on the rerun to the file in `SX_FLAKY_OUT`.
- `require-green.sh` and `required-checks.txt`: see "Release gate".

Machine runs (`run.sh`): when a step fails, only the failing tests run again, once. vitest reruns the failing files in
their packages, cargo test reruns the failing tests by exact name, Playwright reruns the failing spec files. A test
that passes is reported in the summary as flaky, tracked or UNTRACKED (not in `flaky.d/`), and does not fail the step;
a test that fails again fails the step. Anything the rerun cannot tell apart from a real failure (a failure it cannot
name, more failures than the 15 names kept, clippy, tsc, a build step, a compile error) stays a real failure.
Quarantined failures are not rerun. `flaky-lint` runs first in every run, and the summary lists overdue entries.

Pull requests (`ci.yml`, the `web` job): `pr-test.sh` runs each package's tests, vitest packages with `--retry=1`
and the reporter in `vitest-flaky-reporter.mjs`, which
annotates each test that passed only on a retry, and the next step fails the job unless `flaky.d/` or
`quarantine.d/` lists it, so a retry cannot hide a flake: the pull request that meets one adds the entry (owner, a
deadline a day out, an issue) or fixes the test. The reporter also names each test that failed on every try. When a
package's run fails, `pr-test.sh` lets it pass only when every failure is a named test that counts as quarantined
(`flaky-check.sh failed`); a run that failed without naming a test, or with an error outside any test (a file that did
not load, a hook, an unhandled error), stays a failure. The e2e shards (`ci.yml`, `e2e-shard`) hold to the same rule with
Playwright's `--retries=1`: `playwright-results.mjs` reads the JSON report, a test that passed only on the retry must be
on either list, and a test that failed both times fails the job unless it counts as quarantined. The desktop shell's
tests (in `rust tests (core)`, or `rust tests (desktop)` on a hosted runner) run through `cargo-retry.sh`: a failing run reruns its failing tests once by exact name,
as the machine runs do, a test that passes only on the rerun must be on either list (`flaky-check.sh retried`), and
quarantined failures are not rerun or failed on. The other cargo steps on pull requests have no retry; the machine
runs rerun them. A self-hosted run step whose heavy lock is not free within
`SX_HEAVY_WAIT` ends with heavy.sh's status 75 before any test starts: `run-exit.sh` leaves `<report>.gave-up`, and the
results step fails with "no tests ran: the run gave up waiting for the heavy lock" rather than a missing report. Rerun
the job once the lock is free; it is not a test failure.

Adding an entry: open an issue for the test, add its file (for example `flaky.d/481-guard-hold-card.txt`), run
`bash scripts/ci/flaky-check.sh lint`. Fixing one: fix the test and delete its file in the same change.

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
`SX_GREEN_WAIT` seconds (default 3600, an hour: a push to main takes 35 to 43 minutes to turn every required check green) and then counts as not green. `apps/desktop/release/publish.sh` runs it before it
builds or publishes anything. `SX_PUBLISH_CHECK_ONLY=1 publish.sh ...` (or `require-green.sh --dry-run <commit>`) only
reports. `SX_PUBLISH_ALLOW_RED=1` lets a red commit through with a loud warning: for an owner-approved emergency only.
The read uses `gh api` when gh is installed and works. When gh is missing, fails, or `SX_GREEN_GH=0` is set (a machine
where gh is not signed in), the script reads `api.github.com` anonymously with `curl`, follows the `Link` pages, parses
the JSON with `node`, and prints one note on stderr. This works for a public repository only. Anonymous reads are
limited to 60 per hour, so in that mode each wait spreads the reads GitHub says are left (keeping 10 spare) over the
time to its reset: between 20 and 300 seconds, until the reset when none are spare, and 300 seconds when the reply has no
rate limit headers. `SX_GREEN_POLL` overrides it. A 403 or 429 reply ends the run with exit 2 and a rate limit message. With no repository argument the script asks gh, then
reads it from the `origin` URL. `require-green.test.mjs` covers the fallback with a fake `curl` and no network.
Keep `required-checks.txt` in step with the jobs in `ci.yml`.
