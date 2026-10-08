# Testing

How the tests run and how a failure is handled: the per-merge and nightly runs, the heavy-work lock and the flaky
and quarantine lists are in [scripts/ci/README.md](../scripts/ci/README.md). Pull requests run the GitHub workflow in
`.github/workflows/ci.yml`. This page holds proposals for the test runs that are not in place yet.

## Proposal: a nightly shuffled run

Every run today takes the test files, and the tests in each file, in the same order. A test that only passes because
an earlier one left something behind (a module cache, a recorded reply cursor, store state) stays hidden until someone
moves it. A shuffled run finds those tests before they turn into flakes that are hard to read.

### What it runs

- A `vitest-shuffled` step in the nightly tier of `scripts/ci/run.sh`, after the ordered `vitest` step and under the
  same heavy-work lock: every package's tests with `--sequence.shuffle --sequence.seed=<seed>`, which shuffles the
  files and the tests inside each file.
- The seed is the date of the run (`20261008` for 8 October 2026), printed at the top of its log, so a failing night
  can be run again exactly:

      cd packages/app && pnpm exec vitest run --sequence.shuffle --sequence.seed=20261008

- No rerun of a failing test. A rerun would pass in another order and hide exactly what the step looks for.

### How it reports

- The step's result goes in the nightly summary like any other step, with the seed and the failing test names.
- A test that fails shuffled and passed in the ordered step of the same night depends on its order. It gets an issue
  with the seed, like the ones in [#82](https://github.com/slicerx-oss/slicerx/issues/82).
- At first the step reports and does not fail the nightly run, and it does not block `main`. Once it has passed for
  two weeks of nights in a row, it fails the run like the other steps.

### When it starts

After [#82](https://github.com/slicerx-oss/slicerx/issues/82) is fixed. On `main` today 4 to 15 of the app's 213 test
files fail per seed, all known and listed there, so a nightly run before that would only repeat them.
