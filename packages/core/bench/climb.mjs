// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One iteration of the native slice-speed hill-climb. Builds the working tree
// on the reference machine, runs an interleaved A/B against the last kept
// build (the `base` snapshot from run-remote.sh), then the full gated bench and
// a single-thread run, and logs the iteration to results.jsonl and LOG.md. A
// kept change becomes the new base.
//
//   SX_BENCH_HOST=<ssh host> node packages/core/bench/climb.mjs --change "what changed" [--rounds 15] [--fix]
//
// Prints KEEP or REVERT. Reverting the source is the caller's job.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const remote = join(here, 'run-remote.sh')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback
}
const change = opt('--change', '')
const rounds = opt('--rounds', '15')
if (!change) {
  console.error('usage: climb.mjs --change "<one sentence>" [--rounds 15]')
  process.exit(2)
}

// sx bench exits 1 when a gate fails; its JSON is still on stdout.
const run = (...a) => {
  try {
    return execFileSync('sh', [remote, ...a], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
  } catch (e) {
    if (typeof e.stdout === 'string' && e.stdout.includes('{')) return e.stdout
    throw e
  }
}
const lastJson = (out) => JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}')

function treeHash() {
  const h = createHash('sha256')
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(rs|toml)$/.test(name)) h.update(p.slice(root.length)).update(readFileSync(p))
    }
  }
  for (const d of ['packages/core/src', 'packages/core/cli/src', 'packages/core/Cargo.toml']) {
    const p = join(root, d)
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) walk(p)
    else h.update(d).update(readFileSync(p))
  }
  return h.digest('hex').slice(0, 16)
}

const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

const ab = lastJson(run('ab', 'base', '--threads', '0', '--runs', rounds))
const full = lastJson(run('bench', '--runs', '15', '--warmup', '3', '--json'))
const single = lastJson(run('bench', '--runs', '5', '--warmup', '1', '--threads', '1', '--json', '--no-shards'))
const rustc = execFileSync('ssh', [process.env.SX_BENCH_HOST ?? '', 'export PATH="$HOME/.cargo/bin:$PATH"; rustc --version'], { encoding: 'utf8' }).trim().split(' ')[1]
const g = full.gates ?? {}
const gatesOk = g.layers_ok === true && g.gcode_valid === true && Math.abs(g.extrusion_delta_pct ?? 0) <= 1 && g.shard_hash_equal === true
// --fix marks a correctness fix: kept whenever the gates pass, whatever the speed.
const isFix = args.includes('--fix')
const kept = gatesOk && (isFix || ab.gain_pct >= 2)
const entry = {
  ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  loop: 'native-slice',
  machine: 'm3pro-11c',
  rustc,
  base: git('rev-parse', '--short', 'HEAD'),
  diff: treeHash(),
  change: isFix ? `fix: ${change}` : change,
  metric: 'median_ms',
  baseline: ab.baseline_ms,
  candidate: ab.candidate_ms,
  gain_pct: ab.gain_pct,
  full_median: full.median_ms,
  p90: full.p90_ms,
  single_thread_ms: single.median_ms,
  rss_mb: full.rss_mb,
  stage_ms: full.stage_ms,
  gates: { layers: g.layers, gcode_valid: g.gcode_valid, extrusion_delta_pct: g.extrusion_delta_pct, shard_hash_equal: g.shard_hash_equal },
  kept,
}
appendFileSync(join(here, 'results.jsonl'), JSON.stringify(entry) + '\n')
const logPath = join(here, 'LOG.md')
if (!existsSync(logPath)) {
  writeFileSync(
    logPath,
    '# Native slice hill-climb\n\nReference plate at 0.20 mm on the reference machine, `--profile bench-release`. Baseline and candidate are medians of interleaved A/B runs (15 rounds, each the median of 3 runs after 2 warmups). Full median, p90 and gates come from `sx bench --runs 15 --warmup 3` on the candidate. Times in ms.\n\n| # | Time (UTC) | Change | Baseline | Candidate | Gain % | Full median | p90 | 1 thread | RSS MB | Layers | G-code valid | Extrusion delta % | Shards equal | Kept |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n',
  )
}
const n = readFileSync(logPath, 'utf8').split('\n').filter((l) => /^\| \d+ \|/.test(l)).length + 1
appendFileSync(
  logPath,
  `| ${n} | ${entry.ts} | ${entry.change} | ${entry.baseline} | ${entry.candidate} | ${entry.gain_pct} | ${entry.full_median} | ${entry.p90} | ${entry.single_thread_ms} | ${entry.rss_mb} | ${g.layers} | ${g.gcode_valid ? 'yes' : 'no'} | ${g.extrusion_delta_pct} | ${g.shard_hash_equal ? 'yes' : 'no'} | ${kept ? 'yes' : 'no'} |\n`,
)
if (kept) run('snapshot', 'base')
console.log(JSON.stringify({ gain_pct: ab.gain_pct, baseline: ab.baseline_ms, candidate: ab.candidate_ms, gates: entry.gates, single: entry.single_thread_ms, stage_ms: full.stage_ms }))
console.log(kept ? 'KEEP' : 'REVERT')
