# Self-hosted CI

Regression runs on our own machines, with no hosted CI. A bare repo takes pushes; its post-receive hook queues a run
of the pushed tip and starts a worker that runs one at a time. Each machine works in its own checkout under its CI
home (default `~/ci`), never in a developer's working tree.

## Tiers

- per-merge, on every push: `pnpm install`; vitest and `tsc` for the packages changed since the last green run and
  their dependents (`pnpm --filter "...[<green sha>]"`); `cargo test -p` for the crates whose files changed; the
  engine WASM size gate (`build-wasm.sh`, 1040 KB gzip) and the geom module when engine or geom code changed; the
  G-code goldens (`cargo test -p sx-core --test reference`), and clippy with `-D warnings` on the changed crates.
  With no green run yet, it tests everything.
- nightly, at 02:00 local: all vitest and `tsc`, the cargo workspace, the profile parity tests, pgTAP on the local
  Supabase stack where one runs, e2e (Playwright), the integrator sample, and the speed benchmark on the reference
  machine (`SX_CI_BENCH=1`).

A newer push replaces a run still waiting; a run in progress always finishes first. The nightly run has its own slot.
Every run holds the machine's heavy-work lock (`heavy.sh`, default `~/.slicerx-heavy.lock`, or `SX_HEAVY_LOCK`).
Release builds, kit builds and other heavy jobs on the same machine take it too (`scripts/ci/heavy.sh <command>`), so
a run never competes with a build for the CPU and timing tests stay honest. Waiters are served in arrival order, and
`SX_HEAVY_WAIT=<seconds>` makes one give up (exit 75) after that long.

## Results

Each run writes `logs/<run>/`: `run.log`, one log per step, `steps.tsv`, `failures.txt` and `summary.txt`. The last
20 runs are kept. Only the summary (pass or fail, the failing steps and test names, the sha) leaves the machine,
through the command in `SX_CI_NOTIFY`. A green run records its sha in `state/last-green-<platform>`.

Flaky tests go in `quarantine.txt` with an owner and a date: their failures are counted, not failed on.

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

`scripts/ci/heavy-test.sh` tests all of this on a temporary lock: alone on any side, and with
`cross <distro> [<stopped distro>]` from Git Bash, Windows against WSL.
