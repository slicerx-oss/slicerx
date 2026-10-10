# Flaky tests

One file per test that failed, then passed on its one rerun: `<issue>-<slug>.txt`, holding one line:

    name | owner | added (YYYY-MM-DD) | deadline (YYYY-MM-DD) | issue link | why

The name is a substring of the test name as the run reports it. The deadline is at most one day after the date
added; past it the entry counts as quarantined until someone fixes the test and deletes the file. A listed test that
fails again on the rerun is a real failure. `bash scripts/ci/flaky-check.sh lint` checks every file. See "Flaky tests"
in `scripts/ci/README.md`.
