#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Regression run for one commit on this machine, in its own checkout. See scripts/ci/README.md.
#
#   run.sh per-merge <sha>   affected packages and crates since the last green run, tsc, the wasm size gate, the goldens
#   run.sh nightly <sha>     everything: vitest, the cargo workspace, parity, pgTAP, e2e, the dev kit sample, the benchmark
#
# It works in $SX_CI_HOME/work (default ~/ci/work), a clone of $SX_CI_REPO, and refuses any other checkout. Logs go
# to $SX_CI_HOME/logs/<run>/, the last 20 runs are kept, and only a short summary (pass or fail, the failing steps
# and tests, the sha) leaves the machine, through $SX_CI_NOTIFY. A green run records its sha per platform, and the
# next per-merge run tests what changed since then. Machine settings live in $SX_CI_HOME/ci.env, never in the repo.
set -uo pipefail

tier=${1:-}; sha=${2:-}
case $tier in per-merge|nightly) ;; *) echo "usage: run.sh per-merge|nightly <sha>" >&2; exit 2 ;; esac
[ -n "$sha" ] || { echo "run.sh: no sha" >&2; exit 2; }

CI_HOME=${SX_CI_HOME:-$HOME/ci}
[ -f "$CI_HOME/ci.env" ] && . "$CI_HOME/ci.env"
REPO=${SX_CI_REPO:-$CI_HOME/slicerx.git}
WORK=${SX_CI_WORK:-$CI_HOME/work}
LOGS=$CI_HOME/logs
STATE=$CI_HOME/state
KEEP=${SX_CI_KEEP:-20}
mkdir -p "$LOGS" "$STATE"

# Started from a git hook, the environment carries GIT_DIR and friends pointing at the bare repo; drop them so every
# git call below means the checkout it names.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX

case "$(uname -s)" in Darwin) platform=macos ;; Linux) platform=linux ;; *) platform=windows ;; esac
[ -n "${SX_CI_PLATFORM:-}" ] && platform=$SX_CI_PLATFORM

# The checkout must be the CI's own: never a developer's working tree.
case "$WORK" in "$CI_HOME"/*) ;; *) echo "run.sh: refusing to run outside $CI_HOME ($WORK)" >&2; exit 2 ;; esac

# Node 24 and the Rust toolchain: an explicit node directory from ci.env wins, then common installs.
for d in "${SX_CI_NODE_BIN:-}" /opt/homebrew/opt/node@24/bin "$HOME"/.nvm/versions/node/v24*/bin; do
  [ -n "$d" ] && [ -x "$d/node" ] && { PATH="$d:$PATH"; break; }
done
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CI=true
# Tests that drive the real engine (sx) or the cloud service (target/debug/sx-cloud) look for them here. sx-build
# makes both from this commit before vitest: a binary left by an earlier run answered the cloud test from older code.
export SLICERX_TEST_SX_BIN="$WORK/target/release/sx" SLICERX_SX_BIN="$WORK/target/release/sx"

run_id="$(date +%Y%m%dT%H%M%S)-$platform-$tier-${sha:0:8}"
out="$LOGS/$run_id"; mkdir -p "$out"
started=$(date +%s)
: > "$out/steps.tsv"; : > "$out/failures.txt"

log() { echo "$(date +%H:%M:%S) $*" | tee -a "$out/run.log"; }
# A run that stops before its summary still says so where people look, instead of going quiet.
abort() {
  log "$1"
  local msg="SlicerX CI ERROR: $platform $tier ${sha:0:8}: $1 (logs: $out on $(hostname -s))"
  echo "$msg" > "$out/summary.txt"; echo "$msg"
  # shellcheck disable=SC2086
  [ -n "${SX_CI_NOTIFY:-}" ] && $SX_CI_NOTIFY "$msg" >> "$out/run.log" 2>&1
  exit 1
}

# Disk guard: a full disk fails every step at once and can corrupt caches. Below SX_CI_MIN_FREE_GB (15) the run is
# skipped and says so; past SX_CI_MAX_TARGET_GB (10) the checkout's cargo target directory is trimmed first.
free_gb() { df -Pk "$CI_HOME" | awk 'NR==2 { print int($4 / 1048576) }'; }
if [ -d "$WORK/target" ]; then
  tgt_gb=$(du -sk "$WORK/target" 2>/dev/null | awk '{ print int($1 / 1048576) }')
  if [ "${tgt_gb:-0}" -gt "${SX_CI_MAX_TARGET_GB:-10}" ]; then log "trimming $WORK/target (${tgt_gb} GB)"; rm -rf "$WORK/target"; fi
fi
if [ "$(free_gb)" -lt "${SX_CI_MIN_FREE_GB:-15}" ]; then
  msg="SlicerX CI SKIPPED: $platform $tier ${sha:0:8}: only $(free_gb) GB free on $(hostname -s), under ${SX_CI_MIN_FREE_GB:-15} GB. Free space and push again."
  echo "$msg" | tee "$out/summary.txt"
  # shellcheck disable=SC2086
  [ -n "${SX_CI_NOTIFY:-}" ] && $SX_CI_NOTIFY "$msg" >> "$out/run.log" 2>&1
  exit 1
fi

# Checkout: fetch the bare repo and detach at the sha. Ignored build caches (node_modules, target) stay.
# Branches and the side refs a one-off check is queued from (refs/ci/*), so any commit in the bare repo can run.
if [ ! -d "$WORK/.git" ]; then git clone -q "$REPO" "$WORK" || abort "clone failed"; fi
git -C "$WORK" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' '+refs/ci/*:refs/remotes/ci/*' || abort "fetch failed"
git -C "$WORK" cat-file -e "$sha^{commit}" 2>/dev/null || abort "commit $sha is not in $REPO"
git -C "$WORK" checkout -q --detach "$sha" || abort "checkout of $sha failed"
git -C "$WORK" clean -fdq
cd "$WORK" || abort "no checkout at $WORK"
[ "$(git rev-parse HEAD)" = "$(git rev-parse "$sha^{commit}")" ] || abort "checkout does not match $sha"

# Failing test names, by tool, so the summary can name them without carrying logs.
failures_of() {
  # pnpm prefixes each package's output with "<dir> <script>: "; drop it, then pick the tool's own failure lines.
  sed -E 's/^[^ ]+ (test|typecheck|e2e): //' "$1" 2>/dev/null \
    | grep -oE '^test [^ ]+ \.\.\. FAILED|^---- [^ ]+ stdout ----|^ *(FAIL|×) .{0,160}|^ *✘ .{0,160}|error TS[0-9]+: .{0,120}|^[^ ]+\.tsx?\([0-9]+,[0-9]+\): error .{0,100}|^build-wasm: .{0,140}|^error(\[E[0-9]+\])?: .{0,140}|^ +--> [^ ]+:[0-9]+:[0-9]+' \
    | sed -E 's/^test ([^ ]+) \.\.\. FAILED/\1/; s/^---- ([^ ]+) stdout ----/\1/; s/^ +//; s/^FAIL +//' | awk '!seen[$0]++' | head -15
}

quarantined() { # name -> 0 when scripts/ci/quarantine.txt lists it
  [ -f scripts/ci/quarantine.txt ] || return 1
  grep -vE '^\s*(#|$)' scripts/ci/quarantine.txt | cut -d'|' -f1 | sed 's/[[:space:]]*$//' | while read -r pat; do
    [ -n "$pat" ] && case "$1" in *"$pat"*) echo hit; break ;; esac
  done | grep -q hit
}

# step <name> <command...>: runs in the checkout, logs to <run>/<name>.log, records pass, fail or quarantined.
step() {
  local name=$1; shift
  local t0=$(date +%s) rc
  log "step $name: $*"
  ( "$@" ) > "$out/$name.log" 2>&1; rc=$?
  local secs=$(( $(date +%s) - t0 ))
  if [ $rc -eq 0 ]; then printf '%s\tpass\t%s\n' "$name" "$secs" >> "$out/steps.tsv"; log "  pass ($secs s)"; return 0; fi
  local names; names=$(failures_of "$out/$name.log")
  [ -n "$names" ] || names=$(tail -n 3 "$out/$name.log" | cut -c1-160)
  local open=0
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    if quarantined "$n"; then printf '%s\tquarantined\t%s\n' "$name" "$n" >> "$out/failures.txt"
    else printf '%s\tfail\t%s\n' "$name" "$n" >> "$out/failures.txt"; open=1; fi
  done <<< "$names"
  if [ $open -eq 0 ]; then printf '%s\tquarantined\t%s\n' "$name" "$secs" >> "$out/steps.tsv"; log "  failures all quarantined ($secs s)"; return 0; fi
  printf '%s\tfail\t%s\n' "$name" "$secs" >> "$out/steps.tsv"; log "  FAIL ($secs s, rc $rc)"; return 1
}
skip() { printf '%s\tskip\t%s\n' "$1" "$2" >> "$out/steps.tsv"; log "step $1: skipped ($2)"; }

# What changed since the last green run on this platform. No green run yet, or one that is not an ancestor: test all.
green=$(cat "$STATE/last-green-$platform" 2>/dev/null || true)
if [ -n "$green" ] && git merge-base --is-ancestor "$green" HEAD 2>/dev/null; then
  base=$green; changed=$(git diff --name-only "$base" HEAD)
else
  base=""; changed=$(git ls-files)
fi
touched() { grep -qE "$1" <<< "$changed"; }

# Crates whose files changed: the workspace member owning each path (longest manifest dir wins).
touched_crates() {
  if touched '^(Cargo\.lock|Cargo\.toml|rust-toolchain\.toml)$'; then echo WORKSPACE; return; fi
  cargo metadata --no-deps --format-version 1 2>/dev/null | node -e '
    const m = JSON.parse(require("fs").readFileSync(0, "utf8")), root = m.workspace_root + "/"
    const dirs = m.packages.map((p) => [p.manifest_path.replace(root, "").replace(/Cargo\.toml$/, ""), p.name]).sort((a, b) => b[0].length - a[0].length)
    const out = new Set()
    for (const f of process.argv[1].split("\n")) { const hit = dirs.find(([d]) => d && f.startsWith(d)); if (hit) out.add(hit[1]) }
    console.log([...out].join(" "))' "$changed"
}

# pnpm's own change filter: the packages changed since the green sha and everything that depends on them.
pnpm_scope=(-r)
# Every package's tests, two packages at a time: four at once on a laptop pushed timing tests past vitest's limit.
vitest_opts=(--no-bail --workspace-concurrency=2)
[ -n "$base" ] && pnpm_scope=(--filter "...[$base]")

step install pnpm install --frozen-lockfile || true

# The engine module and its 1024 KB gzip budget; the geom module the app tests load.
if [ "$tier" = nightly ] || [ -z "$base" ] || touched '^(packages/core/|packages/geom/|Cargo\.lock|rust-toolchain\.toml)'; then
  if command -v wasm-opt >/dev/null; then
    step wasm-size-gate sh packages/core/web/scripts/build-wasm.sh
  else
    # Without binaryen the module is bigger than the budget by design: build it for the tests, gate it elsewhere.
    skip wasm-size-gate "no wasm-opt on this machine; a runner with binaryen gates the size"
    step wasm-build sh -c 'SX_WASM_OPT=0 sh packages/core/web/scripts/build-wasm.sh || test -s packages/core/web/pkg/sx_wasm.wasm'
  fi
  step geom-wasm sh packages/geom/wasm/scripts/build.sh
else
  skip wasm-size-gate "no engine or geom change since $base"
fi

if [ "$tier" = per-merge ]; then
  if [ -n "$base" ] && ! touched '\.(ts|tsx|js|mjs|json|css)$|(^|/)package\.json$|pnpm-lock\.yaml'; then
    skip vitest "no JS or TS change since ${base:0:8}"; skip tsc "no JS or TS change since ${base:0:8}"
  else
    step sx-build sh -c 'cargo build -p sx-cli --release && cargo build -p sx-cloud'
    step vitest pnpm "${pnpm_scope[@]}" "${vitest_opts[@]}" --if-present test
    step tsc pnpm "${pnpm_scope[@]}" --no-bail --if-present typecheck
  fi
  crates=$(touched_crates)
  if [ "$crates" = WORKSPACE ]; then
    step cargo-test cargo test --workspace
    step clippy cargo clippy --workspace --exclude slicerx-desktop --all-targets -- -D warnings
  elif [ -n "$crates" ]; then
    args=(); for c in $crates; do args+=(-p "$c"); done
    step cargo-test cargo test "${args[@]}"
    # The same lint gate as the hosted workflow, on the crates that changed.
    step clippy cargo clippy "${args[@]}" --all-targets -- -D warnings
  else skip cargo-test "no crate changed since ${base:0:8}"; skip clippy "no crate changed since ${base:0:8}"; fi
  step gcode-goldens cargo test -p sx-core --test reference
else
  step sx-build sh -c 'cargo build -p sx-cli --release && cargo build -p sx-cloud'
  step vitest pnpm -r "${vitest_opts[@]}" --if-present test
  step tsc pnpm -r --no-bail --if-present typecheck
  step cargo-workspace cargo test --workspace
  step clippy cargo clippy --workspace --exclude slicerx-desktop --all-targets -- -D warnings
  step parity cargo test -p sx-settings --test parity --test import_parity --test profiles_parity
  if [ "$platform" = macos ] && command -v docker >/dev/null && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^supabase_db_'; then
    step pgtap sh -c 'npx --yes supabase db reset --local && npx --yes supabase test db --local'
  else skip pgtap "no local Supabase stack on $platform"; fi
  step e2e-browsers pnpm --filter @slicerx/web exec playwright install chromium
  step e2e pnpm --filter @slicerx/web e2e
  step devkit sh -c 'cargo build -p sx-cli --release && SLICERX_SX_BIN="$PWD/target/release/sx" node examples/integrator-sample/scripts/integration.mjs'
  if [ "${SX_CI_BENCH:-0}" = 1 ]; then step speed-benchmark pnpm bench; else skip speed-benchmark "not the reference machine"; fi
fi

# Summary: steps and failing names only. Logs stay here.
secs=$(( $(date +%s) - started ))
fails=$(awk -F'\t' '$2=="fail"' "$out/steps.tsv" | wc -l | tr -d ' ')
total=$(awk -F'\t' '$2!="skip"' "$out/steps.tsv" | wc -l | tr -d ' ')
subject=$(git log -1 --format=%s | cut -c1-80)
if [ "$fails" = 0 ]; then verdict=PASS; else verdict=FAIL; fi
{
  echo "SlicerX CI $verdict: $platform $tier ${sha:0:8} ($subject), $((total - fails))/$total steps in $((secs / 60)) min${base:+, since ${base:0:8}}"
  if [ "$fails" != 0 ]; then
    echo "Failing: $(awk -F'\t' '$2=="fail"{printf "%s%s", sep, $1; sep=", "}' "$out/steps.tsv")"
    awk -F'\t' '$2=="fail"{print "- " $1 ": " $3}' "$out/failures.txt" | head -12
  fi
  q=$(awk -F'\t' '$2=="quarantined"' "$out/failures.txt" | wc -l | tr -d ' ')
  [ "$q" != 0 ] && echo "Quarantined failures: $q (scripts/ci/quarantine.txt)"
  echo "Logs: $out on $(hostname -s)"
} > "$out/summary.txt"
cat "$out/summary.txt"

if [ "$verdict" = PASS ]; then echo "$sha" > "$STATE/last-green-$platform"; fi

# Notify: a command from ci.env that takes the summary text as its one argument (a Discord post, a board comment).
if [ -n "${SX_CI_NOTIFY:-}" ]; then
  # shellcheck disable=SC2086
  $SX_CI_NOTIFY "$(cat "$out/summary.txt")" >> "$out/run.log" 2>&1 || log "notify failed"
fi

# Keep the last $KEEP runs.
ls -1d "$LOGS"/*/ 2>/dev/null | sort | awk -v keep="$KEEP" '{ d[NR] = $0 } END { for (i = 1; i <= NR - keep; i++) print d[i] }' \
  | while read -r d; do rm -rf "$d"; done
[ "$verdict" = PASS ]
