#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Runs one command that fetches something from the network (a toolchain, the packages of a lockfile, a browser) and runs
# it again when it fails, for the steps a short network outage would otherwise fail:
#
#   scripts/ci/net-retry.sh <command> [<arguments>...]
#
# The command runs up to 4 times, with 10, 30 and 60 seconds between the tries. Each failed try is annotated with its
# exit code (a GitHub ::warning:: line on standard error). A try that passes ends the script with 0; after the last try
# the script exits with the command's own exit code, so a step that fails for a real reason still fails with that code,
# after three more tries. SX_NET_RETRY_DELAYS replaces the pauses (seconds, space separated; the number of
# tries is one more than the number of pauses), which a test of this script uses to run without waiting.
#
# This is for downloads only. It never wraps a test command: a failing test is not a network error and gets no rerun
# here (cargo-retry.sh and the flaky rule in scripts/ci/README.md handle tests).
set -u
[ "$#" -gt 0 ] || { echo "usage: net-retry.sh <command> [<arguments>...]" >&2; exit 2; }
delays=${SX_NET_RETRY_DELAYS-10 30 60}
tries=$(($(echo "$delays" | wc -w) + 1))
try=1
while :; do
  "$@"
  rc=$?
  [ "$rc" -eq 0 ] && exit 0
  echo "::warning title=Network retry::try $try of $tries failed with exit code $rc: $*" >&2
  [ "$try" -lt "$tries" ] || exit "$rc"
  # shellcheck disable=SC2086 # the pauses are a word list
  pause=$(set -- $delays; shift $((try - 1)); echo "$1")
  echo "net-retry: waiting ${pause}s before try $((try + 1)) of $tries" >&2
  sleep "$pause"
  try=$((try + 1))
done
