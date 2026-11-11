// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Proves a release build is not a demo build. The SlicerX edition turns demoData on (made-up printers in Search my
// network, the bundled demo catalog in the Vault) whenever SLICERX_SUPABASE_URL and SLICERX_SUPABASE_ANON_KEY are not
// both set at build time (editions/slicerx/edition.config.ts). Dev servers and test builds may be demo builds; a release
// may not.
//   node check-demo-data.mjs [--env] [--dist <frontend dir>]...
// --env   resolves the edition the desktop build would (SLICERX_CONFIG, else the SlicerX edition) in this environment
//         and fails when it has demoData on. Run it before the build. The release scripts pass the backend in the
//         environment; values kept in a git-ignored .env file are covered by --dist.
// --dist  the built frontend (apps/desktop/dist): fails when a script carries the edition with demoData on, or when no
//         script carries the edition's demoData flag at all. Run it after the build, before anything is signed.
// Exits 1 with one line per finding, 0 with a line per check that passed. Prints variable names only, never values.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const desktop = resolve(import.meta.dirname, '..')
const repo = resolve(desktop, '../..')
/** The edition the desktop build uses when SLICERX_CONFIG names none (apps/desktop/vite.config.ts). */
export const DEFAULT_EDITION = join(repo, 'editions/slicerx/edition.config.ts')
/** The variables a SlicerX build needs for its backend; without both it is a demo build. */
export const BACKEND_VARS = ['SLICERX_SUPABASE_URL', 'SLICERX_SUPABASE_ANON_KEY']
const SCRIPTS = /\.m?js$/i
// The edition object the bundler writes into the page, minified (`demoData:!0`) or not (`demoData: true`).
const DEMO_ON = /\bdemoData"?\s*:\s*(?:!0|true)\b/g
const DEMO_OFF = /\bdemoData"?\s*:\s*(?:!1|false)\b/g

/** How often `text` carries the demoData flag on and off. */
export function demoFlags(text) {
  return { on: (text.match(DEMO_ON) ?? []).length, off: (text.match(DEMO_OFF) ?? []).length }
}

/** Every script under `dir` that carries the flag, with its counts. */
export function scanDist(dir) {
  const found = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (SCRIPTS.test(name)) {
        const f = demoFlags(readFileSync(p, 'utf8'))
        if (f.on || f.off) found.push({ file: p, ...f })
      }
    }
  }
  walk(dir)
  return found
}

/**
 * The edition config a build in `env` resolves, from the edition-config CLI in a child process (as publish.sh reads it):
 * the SlicerX edition reads the environment when its file loads, so each environment needs a fresh load.
 */
export function resolveEdition(env = process.env) {
  const cli = join(repo, 'packages/edition-config/src/cli.ts')
  const r = spawnSync(process.execPath, [cli, 'resolve', env['SLICERX_CONFIG'] || DEFAULT_EDITION], { cwd: repo, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`the edition config did not resolve: ${(r.stderr || r.error?.message || '').trim().split('\n').at(-1)}`)
  return JSON.parse(r.stdout)
}

/** All checks; returns the problems found and what passed. `edition` is the resolved config for `env`. */
export function check({ dists = [], env, edition }) {
  const problems = []
  const passed = []
  for (const d of dists) {
    const hits = scanDist(d)
    for (const h of hits.filter((x) => x.on)) problems.push(`${h.file}: the frontend is a demo build (demoData on ${h.on}x)`)
    if (!hits.length) problems.push(`${d}: no script carries the edition's demoData flag, so the build cannot be checked`)
    else if (!hits.some((x) => x.on)) passed.push(`${d}: not a demo build (demoData off in ${hits.length} scripts)`)
  }
  if (edition) {
    if (edition.features.demoData) {
      const missing = env ? BACKEND_VARS.filter((v) => !env[v]) : []
      problems.push(`the ${edition.id} edition resolves with demoData on: this would be a demo build${missing.length ? ` (${missing.join(' and ')} not set)` : ''}`)
    } else passed.push(`the ${edition.id} edition resolves with demoData off`)
  }
  return { problems, passed }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { dist: { type: 'string', multiple: true }, env: { type: 'boolean' } }, strict: true })
  if (!values.dist && !values.env) {
    console.error('usage: check-demo-data.mjs [--env] [--dist <dir>]...')
    process.exit(2)
  }
  const env = values.env ? process.env : undefined
  let edition
  try {
    edition = env ? resolveEdition(env) : undefined
  } catch (e) {
    console.error(`demo build check: ${e.message}`)
    process.exit(1)
  }
  const { problems, passed } = check({ dists: values.dist ?? [], env, edition })
  for (const p of passed) console.log(`ok: ${p}`)
  for (const p of problems) console.error(`demo build check: ${p}`)
  process.exit(problems.length ? 1 : 0)
}
