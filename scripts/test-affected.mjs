// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Prints the smallest set of tests for the files changed since a base: Vitest files related to each changed source
// (in its package and the packages that depend on it), `cargo test -p` for each changed crate and a compile check of
// the crates that depend on it, and the Playwright journeys that cover the changed paths
// (apps/web/e2e/journeys/affected.mjs). It runs them only when asked.
//
//   pnpm test:affected [base]            print the commands (base: public/main, origin/main or main, whichever exists)
//   pnpm test:affected [base] --run      run the Vitest, node --test and cargo commands; print the Playwright one
//   pnpm test:affected [base] --run --e2e
//                                        also run the Playwright command, under scripts/ci/heavy.sh --e2e
//   pnpm test:affected [base] --slow     keep the slow Rust test binaries (slowTests below) in the cargo commands
//   pnpm test:affected [base] --json     the plan as JSON
//
// The files are those that differ from the merge base with the base, committed or not, plus untracked files.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const root = resolve(here, '..')
const read = (p) => readFileSync(p, 'utf8')
const dirOf = (file, dirs) => dirs.filter((d) => file === d || file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0]

// Integration test binaries of a minute or more in the nightly's cargo test (2026-10-16, macOS): left out of a local
// run unless their own file changed or --slow is given. CI runs them on every push to main.
export const slowTests = { 'sx-core': ['firmware', 'requests', 'cancel_rerun', 'session_cache', 'organic2'] }

// A change is wide when it touches this many files, Node packages or crates, or any lockfile, root manifest, workflow or
// e2e harness file. The plan then says where a full run comes from.
const wideFileCount = 40
const widePackageCount = 5
const wideCrateCount = 4
export const fullCiHint = 'This change is wide. For a full run, open or update the pull request and add the `full-ci` label: GitHub\'s hosted runners run the whole suite, and nothing waits for a shared machine.'

// Ports the e2e config and the shared machines already use, never handed out here.
const takenPorts = new Set([4317, 4417, 4418, 4525, 4535, 4717, 4817, 4917, 5017, 5117])

// Workspace packages from pnpm-workspace.yaml: `dir/*` takes each folder with a package.json.
export function nodePackages(base = root) {
  const globs = [...read(join(base, 'pnpm-workspace.yaml')).matchAll(/^\s+-\s+"([^"]+)"/gm)].map((m) => m[1])
  const dirs = globs.flatMap((g) =>
    g.endsWith('/*') && existsSync(join(base, g.slice(0, -2)))
      ? readdirSync(join(base, g.slice(0, -2)), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${g.slice(0, -2)}/${e.name}`)
      : [g],
  )
  const pkgs = new Map()
  for (const dir of dirs) {
    const file = join(base, dir, 'package.json')
    if (!existsSync(file)) continue
    const p = JSON.parse(read(file))
    const deps = Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies })
    pkgs.set(dir, { dir, name: p.name, test: p.scripts?.test ?? '', deps })
  }
  const byName = new Map([...pkgs.values()].map((p) => [p.name, p.dir]))
  for (const p of pkgs.values()) p.deps = p.deps.map((n) => byName.get(n)).filter(Boolean)
  return pkgs
}

// Cargo crates: the workspace members, plus the vendored forks (not members, but members build them by path).
export function crates(base = root) {
  const top = read(join(base, 'Cargo.toml'))
  const members = [...(top.match(/^members\s*=\s*\[([^\]]*)\]/m)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const shared = new Map([...top.matchAll(/^([\w-]+)\s*=\s*\{[^}]*path\s*=\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]))
  const vendor = existsSync(join(base, 'packages/vendor'))
    ? readdirSync(join(base, 'packages/vendor'), { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(base, 'packages/vendor', e.name, 'Cargo.toml'))).map((e) => `packages/vendor/${e.name}`)
    : []
  const all = new Map()
  for (const dir of [...members, ...vendor]) {
    const file = join(base, dir, 'Cargo.toml')
    if (!existsSync(file)) continue
    let section = ''
    let name = ''
    const deps = []
    for (const line of read(file).split('\n')) {
      const head = line.match(/^\s*\[([^\]]+)\]/)
      if (head) { section = head[1]; continue }
      if (section === 'package' && !name) name = line.match(/^name\s*=\s*"([^"]+)"/)?.[1] ?? ''
      if (!/dependencies/.test(section)) continue
      const path = line.match(/path\s*=\s*"([^"]+)"/)?.[1]
      if (path) deps.push(posix.normalize(posix.join(dir, path)))
      const ws = line.match(/^([\w-]+)(?:\.workspace\s*=\s*true|\s*=\s*\{[^}]*workspace\s*=\s*true)/)?.[1]
      if (ws && shared.has(ws)) deps.push(shared.get(ws))
      if (/^dependencies\.|^dev-dependencies\./.test(section) && /workspace\s*=\s*true/.test(line) && shared.has(section.split('.')[1])) deps.push(shared.get(section.split('.')[1]))
    }
    all.set(dir, { dir, name, member: members.includes(dir), deps: deps.filter((d) => d !== dir) })
  }
  for (const c of all.values()) c.deps = c.deps.filter((d) => all.has(d))
  return all
}

// A crate's integration test targets: tests/<name>.rs and tests/<name>/main.rs.
function testTargets(dir) {
  const t = join(dir, 'tests')
  if (!existsSync(t)) return []
  return readdirSync(t, { withFileTypes: true })
    .flatMap((e) => (e.isFile() && e.name.endsWith('.rs') ? [e.name.slice(0, -3)] : e.isDirectory() && existsSync(join(t, e.name, 'main.rs')) ? [e.name] : []))
    .sort()
}

// Everything that depends on `start`, directly or not, in a graph of { deps } nodes.
function dependents(graph, start) {
  const out = new Set()
  const todo = [start]
  while (todo.length) {
    const cur = todo.pop()
    for (const n of graph.values()) if (n.deps.includes(cur) && !out.has(n.dir) && n.dir !== start) { out.add(n.dir); todo.push(n.dir) }
  }
  return [...out]
}

export async function loadJourneys(base = root) {
  const file = join(base, 'apps/web/e2e/journeys/affected.mjs')
  if (!existsSync(file)) return { rows: [], present: new Set() }
  const table = await import(pathToFileURL(file).href)
  const rows = [{ paths: table.smoke ?? [], journeys: ['@smoke'] }, ...(table.journeys ?? [])]
  const dir = join(base, 'apps/web/e2e/journeys')
  const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.spec.ts')).map((f) => f.slice(0, -'.spec.ts'.length)))
  return { rows, present }
}

// CI's browser paths (ci.yml, detect). Rust sources there are left to cargo test and CI's browser suite.
const browserPaths = /^(apps\/web\/|packages\/(app|ui|core|geom|connect)\/)(?!.*(\.rs|Cargo\.toml)$)/
// Changes here stay in their own package: no dependent's tests import them.
const ownOnly = /(^|\/)(e2e|test|tests|scripts)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.config\.[cm]?[jt]s$/
const harness = /^apps\/web\/(playwright\.config\.ts$|e2e\/(fixtures|journey)\.ts$)|^packages\/connect\/mock-printers\//
const docsOnly = /\.(md|txt|png|jpg|jpeg|gif|webp|svg)$|^LICENSES\/|^docs\//
const wide = /^(Cargo\.lock|pnpm-lock\.yaml|package\.json|rust-toolchain\.toml|tsconfig\.base\.json|\.github\/workflows\/)/

// e2e helper files are mapped to the specs that import them, one level deep.
function importers(base, helper) {
  const e2e = join(base, 'apps/web/e2e')
  const specs = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory() && e.name !== 'node_modules') walk(p)
      else if (e.name.endsWith('.spec.ts')) specs.push(p)
    }
  }
  if (existsSync(e2e)) walk(e2e)
  const target = join(base, helper).replace(/\.(m?[jt]s)$/, '')
  return specs
    .filter((s) => [...read(s).matchAll(/from\s+'(\.[^']+)'/g)].some((m) => resolve(dirname(s), m[1]).replace(/\.(m?[jt]s)$/, '') === target))
    .map((s) => relative(base, s).split('\\').join('/'))
}

// The plan for a list of changed files (paths relative to the repository root, forward slashes).
export function plan(files, { base = root, pkgs = nodePackages(base), rust = crates(base), journeys = { rows: [], present: new Set() }, slow = false } = {}) {
  const notes = []
  const exists = (f) => existsSync(join(base, f))
  const code = files.filter((f) => !docsOnly.test(f))

  // Vitest and node --test: the package that holds each file, then every package that depends on it.
  const byPkg = new Map()
  const add = (dir, file, own) => {
    const e = byPkg.get(dir) ?? { files: new Set(), whole: false }
    if (own && !exists(file)) e.whole = true
    else e.files.add(file)
    byPkg.set(dir, e)
  }
  for (const f of code) {
    const dir = dirOf(f, [...pkgs.keys()])
    if (!dir || f.startsWith(`${dir}/e2e/`)) continue
    if (/\.(m?[jt]sx?|css|json)$/.test(f)) {
      add(dir, f, true)
      if (exists(f) && !ownOnly.test(posix.relative(dir, f))) for (const d of dependents(pkgs, dir)) add(d, f, false)
    }
  }
  const vitest = []
  for (const [dir, e] of byPkg) {
    const p = pkgs.get(dir)
    if (!p.test) continue
    if (!p.test.startsWith('vitest')) { vitest.push({ pkg: p.name, cmd: ['pnpm', '--filter', p.name, 'test'] }); continue }
    const rel = [...e.files].map((f) => posix.relative(dir, f))
    vitest.push(e.whole || rel.length === 0
      ? { pkg: p.name, cmd: ['pnpm', '--filter', p.name, 'exec', 'vitest', 'run'] }
      : { pkg: p.name, cmd: ['pnpm', '--filter', p.name, 'exec', 'vitest', 'related', '--run', ...rel.sort()] })
  }

  // Scripts with a test beside them.
  const scripts = [...new Set(code.filter((f) => /^scripts\/.*\.mjs$/.test(f)).map((f) => (f.endsWith('.test.mjs') ? f : f.replace(/\.mjs$/, '.test.mjs'))).filter(exists))]
  if (scripts.length) vitest.push({ pkg: 'scripts', cmd: ['node', '--test', ...scripts.sort()] })

  // Cargo: test the changed member crates (only the named test targets when every change is under tests/),
  // compile-check the members that depend on them, and test the members that build a changed vendored fork.
  const changedCrates = new Map()
  for (const f of code) {
    const dir = dirOf(f, [...rust.keys()])
    if (!dir) continue
    const e = changedCrates.get(dir) ?? { targets: new Set(), all: false }
    const t = posix.relative(dir, f).match(/^tests\/([^/]+?)(\.rs)?(\/|$)/)
    if (t && t[2] && exists(f)) e.targets.add(t[1])
    else e.all = true
    changedCrates.set(dir, e)
  }
  const tested = new Map()
  for (const [dir, e] of changedCrates) {
    const c = rust.get(dir)
    const owners = c.member ? [dir] : dependents(rust, dir).filter((d) => rust.get(d).member && rust.get(d).deps.includes(dir))
    for (const o of owners) {
      const prev = tested.get(o) ?? { targets: new Set(), all: false }
      if (o !== dir || e.all) prev.all = true
      for (const t of e.targets) prev.targets.add(t)
      tested.set(o, prev)
    }
  }
  const cargo = []
  for (const [dir, e] of [...tested].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = rust.get(dir).name
    const skip = slow ? [] : (slowTests[name] ?? []).filter((t) => !e.targets.has(t))
    let targets = []
    if (!e.all) targets = [...e.targets].sort().flatMap((t) => ['--test', t])
    else if (skip.length) {
      targets = ['--lib', '--bins', ...testTargets(join(base, dir)).filter((t) => !skip.includes(t)).flatMap((t) => ['--test', t])]
      notes.push(`cargo test -p ${name} leaves out ${skip.join(', ')} (the slow ones; CI runs them). Add --slow to run them here.`)
    }
    cargo.push({ crate: name, cmd: ['cargo', 'test', '-p', name, ...targets] })
  }
  const widened = [...tested].filter(([d, e]) => e.all || !rust.get(d).member).map(([d]) => d)
  // The desktop shell needs the platform's webview libraries and has CI jobs of its own; it is checked only when it changed.
  const checks = [...new Set(widened.flatMap((d) => dependents(rust, d)))].filter((d) => rust.get(d).member && !tested.has(d) && d !== 'apps/desktop/src-tauri').map((d) => rust.get(d).name).sort()
  if (checks.length) cargo.push({ crate: 'dependents', cmd: ['cargo', 'check', '--tests', ...checks.flatMap((n) => ['-p', n])] })

  // Playwright: changed specs as they are, helpers through the specs that import them, source through the table.
  const specs = new Set()
  const missing = new Set()
  let smoke = false
  let harnessChanged = false
  for (const f of code) {
    if (harness.test(f)) { harnessChanged = true; continue }
    if (/^apps\/web\/e2e\/.*\.spec\.ts$/.test(f)) { if (exists(f)) specs.add(f); continue }
    if (/^apps\/web\/e2e\/.*\.(m?[jt]s)$/.test(f) && !f.endsWith('/affected.mjs')) {
      const users = importers(base, f)
      if (users.length) users.forEach((s) => specs.add(s))
      else smoke = true
      continue
    }
    let best = 0
    let hit = []
    for (const row of journeys.rows) {
      for (const p of row.paths) {
        if (!f.startsWith(p)) continue
        if (p.length > best) { best = p.length; hit = [...row.journeys] }
        else if (p.length === best) hit.push(...row.journeys)
      }
    }
    if (!hit.length && browserPaths.test(f) && !ownOnly.test(f)) smoke = true
    for (const j of hit) {
      if (j === '@smoke') smoke = true
      else if (journeys.present.has(j)) specs.add(`apps/web/e2e/journeys/${j}.spec.ts`)
      else missing.add(j)
    }
  }
  if (missing.size) notes.push(`The journey table names journeys this checkout does not have: ${[...missing].sort().join(', ')}. Check apps/web/e2e/journeys/affected.mjs.`)
  if (harnessChanged) notes.push('The e2e harness changed. CI runs the whole browser suite for that on the pull request, so run only @smoke here and wait for CI.')
  const playwright = []
  const list = [...specs].sort().map((s) => s.replace(/^apps\/web\//, ''))
  const phone = list.some((s) => /\/phone-[^/]*\.spec\.ts$/.test(s))
  if (list.length) playwright.push({ what: 'specs', args: ['playwright', 'test', ...list, '--project=desktop', ...(phone ? ['--project=phone'] : [])] })
  if ((smoke || harnessChanged) && journeys.rows.length) playwright.push({ what: 'smoke', args: ['playwright', 'test', 'e2e/journeys', '--grep', '@smoke', '--project=desktop'] })

  const wideFiles = files.some((f) => wide.test(f))
  if (wideFiles) notes.push('A lockfile, a root manifest or a workflow changed. That reaches every package: test what you meant to change here and let CI run the rest.')
  // A change this size is for GitHub's runners, not for this machine's tests.
  const wideChange = wideFiles || harnessChanged || files.length >= wideFileCount || vitest.length >= widePackageCount || cargo.length >= wideCrateCount
  if (wideChange) notes.push(fullCiHint)
  if (!files.length) notes.push('No changed files.')
  return { files, vitest, cargo, playwright, notes }
}

function changedFiles(base) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  const mb = git(['merge-base', base, 'HEAD'])[0]
  const files = new Set([...git(['diff', '--name-only', mb]), ...git(['ls-files', '--others', '--exclude-standard'])])
  return { mb, files: [...files].sort() }
}

function defaultBase() {
  for (const ref of ['public/main', 'origin/main', 'upstream/main', 'main']) {
    if (spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root }).status === 0) return ref
  }
  throw new Error('test-affected: no base given and none of public/main, origin/main, upstream/main or main exists')
}

// A port for this checkout's e2e run, from its path, so two worktrees on one machine do not collide.
export function e2ePort(path = root) {
  let h = 0
  for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  let port = 5300 + (h % 600)
  while (takenPorts.has(port)) port += 1
  return port
}

const quote = (a) => (/^[\w@./:=,+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
const show = (cmd) => cmd.map(quote).join(' ')
const e2eCmd = (args, port) => ['scripts/ci/heavy.sh', '--e2e', 'env', `SX_E2E_PORT=${port}`, 'pnpm', '--filter', '@slicerx/web', 'exec', ...args]

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const base = argv.find((a) => !a.startsWith('--')) ?? defaultBase()
  const { mb, files } = changedFiles(base)
  const p = plan(files, { journeys: await loadJourneys(), slow: flags.has('--slow') })
  const port = Number(process.env.SX_E2E_PORT) || e2ePort()
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ base, mergeBase: mb, ...p, playwright: p.playwright.map((x) => ({ ...x, cmd: e2eCmd(x.args, port) })) }, null, 2)}\n`)
    return 0
  }
  console.log(`${files.length} changed file${files.length === 1 ? '' : 's'} since ${base} (${mb.slice(0, 8)})\n`)
  const section = (title, rows) => {
    if (!rows.length) return
    console.log(title)
    for (const r of rows) console.log(`  ${show(r)}`)
    console.log('')
  }
  section('Vitest and node --test', p.vitest.map((v) => v.cmd))
  section('Cargo', p.cargo.map((c) => c.cmd))
  section('Playwright (on the CI machine, under the heavy lock; needs target/release/sx or SX_CLI_BIN)', p.playwright.map((x) => e2eCmd(x.args, port)))
  if (!p.vitest.length && !p.cargo.length && !p.playwright.length) console.log('Nothing to test locally for these files.\n')
  for (const n of p.notes) console.log(`Note: ${n}`)
  if (!flags.has('--run')) return 0

  let rc = 0
  const run = (cmd) => {
    console.log(`\n$ ${show(cmd)}`)
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    if (r.status === 75) console.log(`test-affected: the heavy lock stayed busy for ${process.env.SX_HEAVY_WAIT} s, so no tests ran; see the heavy.sh lines above`)
    if (r.status !== 0) rc = r.status || 1
  }
  for (const v of p.vitest) run(v.cmd)
  for (const c of p.cargo) run(c.cmd)
  // An agent's browser run waits at most 30 minutes for the heavy lock (heavy.sh exits 75 then, with no tests run),
  // so a busy or wedged machine fails the run instead of leaving the agent idle; a wait the caller set wins.
  if (flags.has('--e2e')) process.env.SX_HEAVY_WAIT ??= '1800'
  if (flags.has('--e2e')) for (const x of p.playwright) run(e2eCmd(x.args, port))
  else if (p.playwright.length) console.log('\nPlaywright not run: add --e2e on the CI machine.')
  return rc
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((rc) => process.exit(rc), (e) => { console.error(e.message); process.exit(2) })
}
