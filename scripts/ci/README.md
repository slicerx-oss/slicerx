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
Every run holds the machine's heavy-work lock (`heavy.sh`, default `~/.slicerx-heavy.lock`). Release builds, kit
builds and other heavy jobs on the same machine take it too (`scripts/ci/heavy.sh <command>`), so a run never
competes with a build for the CPU and timing tests stay honest.

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
