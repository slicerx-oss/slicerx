#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs the same-results harness (packages/app/test/native-same-results.test.ts): every design replayed step by step
// on the native Model engine and on the browser engine, mesh steps compared bit for bit and exact steps by face count,
// bounds, volume and distance. Unlike a plain vitest run it never skips: a missing engine fails it.
//
//   node scripts/ci/native-same-results.mjs [--native <engine>] [--native-args <json>] [--wasm <module>]
//                                           [--hulls <folder of .sx3mf>] [--out <report.json>] [--grep <test name pattern>]
//
// --native is the engine process the desktop app starts: its own binary with `--sx-geom-engine` (the default
// arguments), built with the native-geom feature (cargo build -p slicerx-desktop --features native-geom, with
// SX_BREP_REQUIRE=1 and the kernel from packages/brep/scripts/fetch-smlib.sh). Default: SLICERX_GEOM_SERVE_BIN.
// --wasm is the browser engine (packages/geom/wasm/scripts/build.sh). Default: SX_GEOM_WASM, then the built module.
// The report (default target/native-same-results.json) lists every design, its step counts and each difference. Exit
// status: 0 when every step matched, 1 when any differs, 2 when the run could not start. --grep runs only the tests whose
// names match (vitest -t), to split a long run.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function args(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const v = argv[++i]
    if (v === undefined) throw new Error(`${a} needs a value`)
    out[a.slice(2)] = v
  }
  return out
}

function fail(message) {
  console.error(`native-same-results: ${message}`)
  process.exit(2)
}

let opts
try {
  opts = args(process.argv.slice(2))
} catch (e) {
  fail(e.message)
}
for (const k of Object.keys(opts)) if (!['native', 'native-args', 'wasm', 'hulls', 'out', 'grep'].includes(k)) fail(`unknown option --${k}`)

const native = opts.native ?? process.env.SLICERX_GEOM_SERVE_BIN
const nativeArgs = opts['native-args'] ?? process.env.SLICERX_GEOM_SERVE_ARGS ?? '["--sx-geom-engine"]'
const wasm = resolve(opts.wasm ?? process.env.SX_GEOM_WASM ?? join(root, 'packages', 'geom', 'wasm', 'pkg', 'sx_geom_wasm.wasm'))
const hulls = opts.hulls ?? process.env.SX_SAME_RESULTS_HULLS
const out = resolve(opts.out ?? process.env.SX_SAME_RESULTS_OUT ?? join(root, 'target', 'native-same-results.json'))

if (!native) fail('no native engine: pass --native or set SLICERX_GEOM_SERVE_BIN')
if (!existsSync(native)) fail(`no native engine at ${native}`)
if (!existsSync(wasm)) fail(`no browser engine at ${wasm}: build it with packages/geom/wasm/scripts/build.sh`)
try {
  if (!Array.isArray(JSON.parse(nativeArgs))) throw new Error('not a list')
} catch (e) {
  fail(`--native-args must be a JSON list of strings: ${e.message}`)
}
if (hulls && !existsSync(hulls)) fail(`no hull folder at ${hulls}`)

const env = {
  ...process.env,
  SLICERX_GEOM_SERVE_BIN: resolve(native),
  SLICERX_GEOM_SERVE_ARGS: nativeArgs,
  SX_GEOM_WASM: wasm,
  SX_SAME_RESULTS_REQUIRE: '1',
  SX_SAME_RESULTS_OUT: out,
  ...(hulls ? { SX_SAME_RESULTS_HULLS: resolve(hulls) } : {}),
}
// recordings never stand in for the engines here
delete env.SX_GEOM_REPLAY
delete env.SX_GEOM_RECORD

console.log(`native-same-results: native ${env.SLICERX_GEOM_SERVE_BIN} ${nativeArgs}\nnative-same-results: browser ${wasm}${hulls ? `\nnative-same-results: hulls ${env.SX_SAME_RESULTS_HULLS}` : ''}`)
const vitest = ['--filter', '@slicerx/app', 'exec', 'vitest', 'run', 'test/native-same-results.test.ts', '--maxWorkers=1', ...(opts.grep ? ['-t', opts.grep] : [])]
// Windows runs pnpm through the shell (pnpm.cmd), which splits on spaces and reads | itself: such arguments go quoted
const win = process.platform === 'win32'
const run = spawnSync('pnpm', win ? vitest.map((a) => (/[\s|&<>^"]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a)) : vitest, { cwd: root, env, stdio: 'inherit', shell: win })
if (run.error) fail(`vitest did not start: ${run.error.message}`)

if (!existsSync(out)) fail(`vitest exited ${run.status} and wrote no report at ${out}`)
const report = JSON.parse(readFileSync(out, 'utf8'))
const all = report.designs.flatMap((d) => d.differences)
const byOp = new Map()
for (const d of all) {
  const k = `${d.op} ${d.kind} ${d.field}`
  byOp.set(k, (byOp.get(k) ?? 0) + 1)
}
console.log(`\nnative-same-results: ${report.designs.length} designs, ${report.designs.reduce((n, d) => n + d.steps, 0)} steps (${report.designs.reduce((n, d) => n + d.exactSteps, 0)} exact), ${all.length} differences; report ${out}`)
for (const d of report.designs) console.log(`  ${d.differences.length ? 'DIFFERS' : 'same   '} ${d.name}: ${d.steps} steps, ${d.exactSteps} exact, ${d.differences.length} differences`)
if (byOp.size) {
  console.log('differences by op, kind and field:')
  for (const [k, n] of [...byOp].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${k}`)
}
process.exit(run.status === 0 && all.length === 0 ? 0 : 1)
