// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Proves a release build carries no agent bridge (docs/agent-bridge.md): the bridge is for dev and test builds only.
//   node check-agent-bridge.mjs [--binary <app binary>]... [--dist <frontend dir>]... [--manifest <Cargo.toml>] [--env]
// --binary   the built app (slicerx.exe, the Linux slicerx, the macOS app's Contents/MacOS binary): fails on the shell
//            side's names, which are plain strings in any binary built with the `agent-bridge` Cargo feature.
// --dist     the built frontend (apps/desktop/dist): fails on the page side's names, which a build with
//            SLICERX_AGENT_BRIDGE=1 keeps and every other build drops as dead code.
// --manifest the desktop crate's Cargo.toml: fails when a default feature turns `agent-bridge` on.
// --env      fails when this environment would make a bridge build (SLICERX_AGENT_BRIDGE=1).
// Exits 1 with one line per finding, 0 with a line per check that passed.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Names only the shell side of the bridge has (apps/desktop/src-tauri/src/agent_bridge). */
export const SHELL_MARKERS = ['SX_AGENT_BRIDGE_PORT', 'agent_bridge_reply', 'sx-agent-bridge']
/** Names only the page side has (packages/app/src/agent-bridge). */
export const PAGE_MARKERS = ['agent_bridge_ready', 'agent_bridge_reply', 'sx-agent-bridge']
const PAGE_FILES = /\.(m?js|html)$/i

/** The markers found in `bytes`. */
export function markersIn(bytes, markers) {
  return markers.filter((m) => bytes.indexOf(Buffer.from(m, 'utf8')) >= 0)
}

/** Every file under `dir` the page loads, with the markers it holds. */
export function scanDist(dir) {
  const found = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (PAGE_FILES.test(name)) {
        const hits = markersIn(readFileSync(p), PAGE_MARKERS)
        if (hits.length) found.push({ file: p, markers: hits })
      }
    }
  }
  walk(dir)
  return found
}

/** The `[features]` table of a Cargo.toml: each feature and what it turns on. Only the plain one-line form Cargo.toml uses here. */
export function cargoFeatures(toml) {
  const out = {}
  let inFeatures = false
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line.startsWith('[')) {
      inFeatures = line === '[features]'
      continue
    }
    if (!inFeatures || !line) continue
    const m = /^([A-Za-z0-9_-]+)\s*=\s*\[(.*)\]$/.exec(line)
    if (!m) throw new Error(`cannot read the feature line: ${raw.trim()}`)
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  }
  return out
}

/** Whether building with the default features turns on `feature`, directly or through another feature. */
export function defaultEnables(features, feature = 'agent-bridge') {
  const seen = new Set()
  const stack = [...(features.default ?? [])]
  while (stack.length) {
    const f = stack.pop()
    if (f === feature) return true
    if (seen.has(f) || f.startsWith('dep:') || f.includes('/')) continue
    seen.add(f)
    stack.push(...(features[f] ?? []))
  }
  return false
}

/** All checks; returns the problems found and what passed. */
export function check({ binaries = [], dists = [], manifest, env }) {
  const problems = []
  const passed = []
  for (const b of binaries) {
    const hits = markersIn(readFileSync(b), SHELL_MARKERS)
    if (hits.length) problems.push(`${b}: built with the agent bridge (found ${hits.join(', ')})`)
    else passed.push(`${b}: no agent bridge`)
  }
  for (const d of dists) {
    const hits = scanDist(d)
    for (const h of hits) problems.push(`${h.file}: the frontend has the agent bridge (found ${h.markers.join(', ')})`)
    if (!hits.length) passed.push(`${d}: no agent bridge in the frontend`)
  }
  if (manifest) {
    if (defaultEnables(cargoFeatures(readFileSync(manifest, 'utf8')))) problems.push(`${manifest}: a default feature turns agent-bridge on`)
    else passed.push(`${manifest}: agent-bridge is not a default feature`)
  }
  if (env) {
    if (env.SLICERX_AGENT_BRIDGE === '1') problems.push('SLICERX_AGENT_BRIDGE=1 is set: this would be a bridge build')
    else passed.push('the environment makes no bridge build')
  }
  return { problems, passed }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: { binary: { type: 'string', multiple: true }, dist: { type: 'string', multiple: true }, manifest: { type: 'string' }, env: { type: 'boolean' } },
    strict: true,
  })
  if (!values.binary && !values.dist && !values.manifest && !values.env) {
    console.error('usage: check-agent-bridge.mjs [--binary <file>]... [--dist <dir>]... [--manifest <Cargo.toml>] [--env]')
    process.exit(2)
  }
  const { problems, passed } = check({ binaries: values.binary ?? [], dists: values.dist ?? [], manifest: values.manifest, env: values.env ? process.env : undefined })
  for (const p of passed) console.log(`ok: ${p}`)
  for (const p of problems) console.error(`agent bridge check: ${p}`)
  process.exit(problems.length ? 1 : 0)
}
