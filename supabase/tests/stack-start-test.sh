#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Tests the port helpers of stack-start.sh without Docker: sx_port_busy sees a port held by a connection that is not
# listening, and sx_reserved_ranges reads both stacks' port ranges from config.toml.
#
# Usage: sh supabase/tests/stack-start-test.sh
set -u
here=$(cd "$(dirname "$0")" && pwd)
. "$here/stack-start.sh"
fails=0
check() {
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fails=$((fails + 1)); fi
}
equal() { [ "$1" = "$2" ] || { echo "     got '$1', want '$2'" >&2; return 1; }; }

name="ranges: main stack and the second stack"
check equal "$(sx_reserved_ranges "$here/../config.toml" 5532)" "54320-54329,55320-55329"
name="ranges: another prefix for the second stack"
check equal "$(sx_reserved_ranges "$here/../config.toml" 5632)" "54320-54329,56320-56329"

if command -v python3 >/dev/null 2>&1 && command -v ss >/dev/null 2>&1; then
  tmp=$(mktemp -d)
  # A listener on one port, and a client that uses a second port as its local port: nothing listens on the second one.
  python3 - "$tmp" <<'PY' &
import socket, sys, time
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0)); srv.listen(1)
cli = socket.socket(); cli.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
cli.bind(("127.0.0.1", 0)); cli.connect(srv.getsockname()); conn, _ = srv.accept()
open(sys.argv[1] + "/ports", "w").write("%d %d\n" % (srv.getsockname()[1], cli.getsockname()[1]))
time.sleep(60)
PY
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$tmp/ports" ] && break; sleep 0.25; done
  read -r listen_port client_port < "$tmp/ports"
  name="busy: a listening port"
  check sx_port_busy "$listen_port"
  name="busy: a port that only a connection uses"
  check sx_port_busy "$client_port"
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  name="free: a port nothing uses"
  check sh -c '. "$1"; ! sx_port_busy 1' sh "$here/stack-start.sh"
  rm -rf "$tmp"
else
  echo "skip busy-port cases: python3 or ss is missing"
fi

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails failed"
exit "$fails"
