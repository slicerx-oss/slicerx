# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Sourced (not run) by the scripts that start a local Supabase stack. Docker can keep a published port for a
# moment after the stack that held it stopped, and the next start then fails with "driver failed programming
# external connectivity". sx_stack_start retries the start: on a failure it stops the stack, waits until the
# stack's ports are free, and tries again, three times at most.
#
# Usage: . supabase/tests/stack-start.sh
#        sx_stack_start "$cli" -x studio,imgproxy   (run in the directory that holds supabase/config.toml)
# SX_STACK_PORT_WAIT is how many seconds to wait for the ports (default 60).

# True when something listens on the port.
sx_port_busy() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" { f = 1 } END { exit !f }'
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  fi
}

# The ports config.toml sets (port and *_port keys that are not commented out), one per line.
sx_stack_ports() {
  sed -n 's/^[[:space:]]*[a-z_]*port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${1:-supabase/config.toml}" | sort -un
}

# Waits up to SX_STACK_PORT_WAIT seconds for every port to be free. Prints the port that never freed and fails.
sx_wait_ports_free() {
  sx_left=${SX_STACK_PORT_WAIT:-60}
  while :; do
    sx_held=
    for sx_p in "$@"; do
      if sx_port_busy "$sx_p"; then sx_held=$sx_p; break; fi
    done
    [ -z "$sx_held" ] && return 0
    if [ "$sx_left" -le 0 ]; then
      echo "port $sx_held is still in use after ${SX_STACK_PORT_WAIT:-60} s" >&2
      return 1
    fi
    sleep 1
    sx_left=$((sx_left - 1))
  done
}

sx_stack_start() {
  sx_cli=$1
  shift
  sx_ports=$(sx_stack_ports)
  sx_try=1
  while :; do
    # shellcheck disable=SC2086 # the CLI may be several words, such as "npx -y supabase@x"
    if $sx_cli start "$@"; then return 0; fi
    echo "supabase start failed (attempt $sx_try of 3)" >&2
    # shellcheck disable=SC2086
    $sx_cli stop --no-backup || true
    # shellcheck disable=SC2086
    sx_wait_ports_free $sx_ports || return 1
    [ "$sx_try" -ge 3 ] && return 1
    sx_try=$((sx_try + 1))
  done
}
