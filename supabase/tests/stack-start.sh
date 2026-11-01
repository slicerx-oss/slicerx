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

# True when anything holds the port: a listener, but also a connection that uses it as its local port, which a
# listen check misses. A published port can fail to bind ("address already in use") because of such a connection, and
# the ports of a stack sit inside the range Linux hands to outgoing connections (sx_reserve_ports keeps them out).
sx_port_busy() {
  if command -v ss >/dev/null 2>&1 && sx_ss_out=$(ss -tan "( sport = :$1 )" 2>/dev/null); then
    [ -n "$(printf '%s\n' "$sx_ss_out" | sed 1d)" ]
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  fi
}

# The ports config.toml sets (port and *_port keys that are not commented out), one per line.
sx_stack_ports() {
  sed -n 's/^[[:space:]]*[a-z_]*port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' "${1:-supabase/config.toml}" | sort -un
}

# The port ranges (low-high, comma separated) of the main stack and the second stack of no-default-grants.sh, read from
# config.toml: the ports that start with 5432, and the same ports with 5432 swapped for the second stack's prefix
# (SX_NOGRANTS_PORTS, default 5532). Arguments: the config file and the second stack's prefix.
sx_reserved_ranges() {
  sx_main=$(sx_stack_ports "${1:-supabase/config.toml}" | grep '^5432[0-9]$')
  [ -n "$sx_main" ] || return 1
  sx_second=$(printf '%s\n' "$sx_main" | sed "s/^5432/${2:-5532}/")
  sx_lo_hi() { printf '%s\n' "$1" | sed -n '1p;$p' | paste -sd- -; }
  printf '%s,%s\n' "$(sx_lo_hi "$sx_main")" "$(sx_lo_hi "$sx_second")"
}

# Keeps the stacks' ports out of the range Linux gives to outgoing connections (needs root; CI runs it with sudo).
# Usage: sudo sh -c '. supabase/tests/stack-start.sh; sx_reserve_ports'
sx_reserve_ports() {
  sx_ranges=$(sx_reserved_ranges "${1:-supabase/config.toml}" "${SX_NOGRANTS_PORTS:-5532}") || return 1
  sx_old=$(sysctl -n net.ipv4.ip_local_reserved_ports 2>/dev/null || true)
  sysctl -w "net.ipv4.ip_local_reserved_ports=${sx_old:+$sx_old,}$sx_ranges"
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
