# Quarantined tests

One file per flaky test that must not fail a CI run: `<issue>-<slug>.txt`, holding one line:

    name | owner | added (YYYY-MM-DD) | issue link | why

A quarantined failure still shows in the summary as a count. Delete the file when the test is fixed; nothing stays here
without an owner, a date and an issue (`bash scripts/ci/flaky-check.sh lint` fails otherwise). A `flaky.d` entry past
its deadline counts as quarantined. See "Flaky tests" in `scripts/ci/README.md`.
