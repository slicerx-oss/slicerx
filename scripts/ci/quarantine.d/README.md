# Quarantined tests

One file per flaky test that must not fail a CI run: `<issue>-<slug>.txt`, holding one line:

    name | owner | added (YYYY-MM-DD) | issue link | why

A quarantined failure still shows in the summary as a count. Delete the file when the test is fixed; nothing stays here
without an owner, a date and an issue (`bash scripts/ci/flaky-check.sh lint` fails otherwise). A `flaky.d` entry past
its deadline counts as quarantined. An entry added more than 14 days ago is stale: every run warns with its age and
issue until the test is fixed. Quarantine works for vitest tests in the pull request job, the Playwright shards, the
desktop shell's cargo tests and the machine runs. See "Flaky tests" in `scripts/ci/README.md`.
