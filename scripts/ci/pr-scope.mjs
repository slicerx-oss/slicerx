// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What a pull request's change needs from CI (.github/workflows/ci.yml): which of the rust, wasm and desktop-bridge
// jobs run, and which packages the web job tests. The merge queue, a push to main, a run by hand and a pull request
// labeled full-ci never ask: they run everything, as before.
//
//   node scripts/ci/pr-scope.mjs jobs <base> [head]   rust=, wasm=, bridge= (true or false) and web= (all or changed)
//   node scripts/ci/pr-scope.mjs web <base>           packages= (the names the web job tests), engine= and chromium=
//   add --files-from <file> (or - for stdin) to read the changed files from a list instead of git diff
//
// A job runs when a changed file is something it builds or reads:
// - rust: any Cargo crate's directory (the workspace members and the vendored forks), the files those crates read from
//   outside their own directory (string paths in their .rs files, found here, not listed by hand), or the shared Rust
//   inputs below.
// - desktop-bridge: as rust, for the desktop shell's crate and the crates it builds, plus the bridge check script.
// - wasm: as rust, for the two wasm crates and the crates they build, and the web app's production build: any non-test
//   file of @slicerx/web or a workspace package it depends on. A change the web job tests in full (below) runs it too.
// - web: a change inside workspace packages tests those packages and every package that depends on them (pnpm's
//   "...[base]" filter; a change to test files only does not take the dependents), and the packages whose files read a
//   changed package's files without depending on it (string paths, found here). Any changed file outside every
//   workspace package (shared config, the lockfile, ci.yml, scripts/ci, docs, knowledge, the Rust-only crates, ...) tests
//   every package, since tests read such files directly.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crates, nodePackages, root } from '../test-affected.mjs'

// Changes here run every Rust job: the workspace manifest and lockfile, the toolchain, cargo's config, formatting, and
// CI itself (this workflow and scripts/ci, which holds every script the jobs run).
export const rustShared = /^(Cargo\.(toml|lock)$|rust-toolchain\.toml$|\.cargo\/|rustfmt\.toml$|\.github\/workflows\/ci\.yml$|scripts\/ci\/)/
// The desktop-bridge job's own check, outside the crate.
const bridgeExtra = /^apps\/desktop\/release\/check-agent-bridge\.mjs$/
// Test files and folders: never part of a build, and a change to test files only does not test the dependents.
export const testFile = /(^|\/)(test|tests|e2e|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/
// pnpm's --test-pattern: test files that nothing else imports (scripts/ci/pr-scope.test.mjs checks that no file
// imports one), so a change to them alone tests only their own package.
export const testPatterns = ['**/*.test.*', '**/*.spec.*']
// Packages whose tests need the geometry engine built: the app's fail on CI without it, the pilot's skip. The MCP
// server's run on the replies recorded from it when it is not built (the replay job runs those too).
export const enginePackages = ['@slicerx/app', '@slicerx/pilot']
export const replayPackages = ['@slicerx/mcp']
// Packages with tests that lay out in a real Chromium.
export const chromiumPackages = ['@slicerx/ui', '@slicerx/viewport']

const tracked = (base) => execFileSync('git', ['ls-files', '-z'], { cwd: base, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const inDir = (f, d) => d === '' || f === d || f.startsWith(`${d}/`)
const deepest = (f, dirs) => dirs.filter((d) => inDir(f, d)).sort((a, b) => b.length - a.length)[0]

// A view of the tree: tracked files, their folders, the crates and the workspace packages.
export function tree(base = root, files = tracked(base)) {
  const dirs = new Set()
  for (const f of files) for (let d = posix.dirname(f); d !== '.'; d = posix.dirname(d)) dirs.add(d)
  return { base, files, fileSet: new Set(files), dirs, rust: crates(base), pkgs: nodePackages(base) }
}

// A path written in a source file, resolved against `from`, kept when it names a tracked file or folder of the
// repository that is not the repository itself.
function keep(t, from, lit) {
  const p = posix.normalize(posix.join(from, lit))
  if (p === '.' || p.startsWith('..')) return null
  if (t.fileSet.has(p) || t.dirs.has(p)) return p
  // an import written without its extension
  return ['.ts', '.tsx', '.mts', '.mjs', '.js'].map((x) => p + x).find((x) => t.fileSet.has(x)) ?? null
}
const topDirs = 'apps|packages|editions|examples|knowledge|docs|design|supabase|scripts'

// The paths one source file names: relative literals ('../x', against the file's folder and against `alsoFrom`),
// literals from the repository root ('packages/x'), and the string arguments of a join() or resolve() call, joined.
export function namedPaths(t, file, text, alsoFrom) {
  const out = new Set()
  const add = (p) => { if (p) out.add(p) }
  const dir = posix.dirname(file)
  for (const m of text.matchAll(/(['"`])((?:\.\.\/)+[^'"`\s$]+)\1/g)) {
    add(keep(t, dir, m[2]))
    if (alsoFrom) add(keep(t, alsoFrom, m[2]))
  }
  for (const m of text.matchAll(new RegExp(`(['"\`])((?:${topDirs})/[^'"\`\\s$]+)\\1`, 'g'))) add(keep(t, '', m[2]))
  for (const m of text.matchAll(/\b(?:join|resolve)\(/g)) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    while (i < text.length && depth > 0) { if (text[i] === '(') depth++; else if (text[i] === ')') depth--; i++ }
    const lits = [...text.slice(start, i - 1).matchAll(/'([^'\n]*)'|"([^"\n]*)"/g)].map((x) => x[1] ?? x[2])
    if (lits.length < 2 || !lits.some((l) => l === '..' || l.startsWith('../'))) continue
    const joined = lits.join('/')
    add(keep(t, dir, joined))
    if (alsoFrom) add(keep(t, alsoFrom, joined))
  }
  // a path that only climbs (the repository, or a folder above the file) names nothing in particular
  for (const p of [...out]) if (inDir(file, p) || (alsoFrom && inDir(alsoFrom, p))) out.delete(p)
  return out
}

// The files and folders each crate reads from outside its own directory, from the string paths in its .rs files
// (include_str!, include_bytes!, CARGO_MANIFEST_DIR joins, test fixtures).
export function crateReads(t) {
  if (t.crateReads) return t.crateReads
  const crateDirs = [...t.rust.keys()]
  const reads = new Map(crateDirs.map((d) => [d, new Set()]))
  for (const f of t.files) {
    if (!f.endsWith('.rs')) continue
    const c = deepest(f, crateDirs)
    if (!c) continue
    for (const p of namedPaths(t, f, readFileSync(posix.join(t.base, f), 'utf8'), c)) if (!inDir(p, c)) reads.get(c).add(p)
  }
  t.crateReads = reads
  return reads
}

// The crate directories a set of crates builds: themselves and every crate they depend on, transitively.
export function crateClosure(t, start) {
  const out = new Set()
  const todo = [...start]
  while (todo.length) {
    const d = todo.pop()
    if (out.has(d) || !t.rust.has(d)) continue
    out.add(d)
    todo.push(...t.rust.get(d).deps)
  }
  return out
}

// The workspace packages a package builds from: itself and its dependencies, transitively.
function pkgClosure(t, start) {
  const out = new Set()
  const todo = [start]
  while (todo.length) {
    const d = todo.pop()
    if (out.has(d) || !t.pkgs.has(d)) continue
    out.add(d)
    todo.push(...t.pkgs.get(d).deps)
  }
  return out
}

// For each workspace package, the other packages whose files it reads by path without depending on them (a test reading
// another package's fixture or source). A change to one of those runs the reader's tests too.
export function packageReaders(t) {
  if (t.packageReaders) return t.packageReaders
  const dirs = [...t.pkgs.keys()]
  const readers = new Map()
  for (const f of t.files) {
    if (!/\.(m?[jt]sx?|cjs|cts|mts)$/.test(f) || f.includes('node_modules/')) continue
    const p = deepest(f, dirs)
    if (!p) continue
    const own = pkgClosure(t, p)
    for (const path of namedPaths(t, f, readFileSync(posix.join(t.base, f), 'utf8'))) {
      // the package holding the path, or every package inside a folder it names
      const q = deepest(path, dirs)
      const targets = q ? [q] : dirs.filter((d) => inDir(d, path))
      for (const target of targets) {
        if (own.has(target)) continue
        if (!readers.has(target)) readers.set(target, new Set())
        readers.get(target).add(p)
      }
    }
  }
  t.packageReaders = readers
  return readers
}

// The jobs a pull request's changed files need.
export function jobs(files, t = tree()) {
  const reads = crateReads(t)
  const crateDirs = [...t.rust.keys()]
  const pkgDirs = [...t.pkgs.keys()]
  const touches = (set) => {
    const paths = [...set].flatMap((c) => [c, ...(reads.get(c) ?? [])])
    return files.some((f) => paths.some((p) => inDir(f, p)))
  }
  const shared = files.some((f) => rustShared.test(f))
  const rust = shared || touches(new Set(crateDirs))
  const bridge = shared || files.some((f) => bridgeExtra.test(f)) || touches(crateClosure(t, ['apps/desktop/src-tauri']))
  const outside = files.filter((f) => !deepest(f, pkgDirs))
  const web = outside.length ? 'all' : 'changed'
  const webBuild = pkgClosure(t, 'apps/web')
  const wasm = shared || web === 'all' || touches(crateClosure(t, ['packages/core/wasm', 'packages/geom/wasm'])) ||
    files.some((f) => !testFile.test(f) && webBuild.has(deepest(f, pkgDirs)))
  return { rust, wasm, bridge, web, outside }
}

// The web job's packages for a change inside workspace packages: pnpm's "...[base]" selection (with the test patterns)
// plus each changed package's readers (only the reader: its dependents do not read the file).
export function webArgs(files, base, t = tree()) {
  const pkgDirs = [...t.pkgs.keys()]
  const readers = packageReaders(t)
  const extra = new Set()
  for (const f of files) for (const r of readers.get(deepest(f, pkgDirs)) ?? []) extra.add(t.pkgs.get(r).name)
  return [
    '--filter', `...[${base}]`,
    ...testPatterns.flatMap((p) => ['--test-pattern', p]),
    ...[...extra].sort().flatMap((n) => ['--filter', n]),
  ]
}

export function web(names) {
  const has = (list) => list.some((n) => names.includes(n))
  return { packages: names, engine: has(enginePackages), chromium: has(chromiumPackages) }
}

function changedFiles(args) {
  const at = args.indexOf('--files-from')
  if (at >= 0) {
    const src = args[at + 1]
    args.splice(at, 2)
    return readFileSync(src === '-' ? 0 : src, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  }
  const [base, head = 'HEAD'] = args.slice(1)
  return execFileSync('git', ['diff', '--name-only', base, head], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function main(argv) {
  const args = [...argv]
  const files = changedFiles(args)
  const [mode, base] = args
  if (!base || !['jobs', 'web'].includes(mode)) {
    console.error('usage: pr-scope.mjs jobs|web <base> [head] [--files-from <file>|-]')
    return 2
  }
  const t = tree()
  if (mode === 'jobs') {
    const j = jobs(files, t)
    console.log(`rust=${j.rust}\nwasm=${j.wasm}\nbridge=${j.bridge}\nweb=${j.web}`)
    console.error(`pr-scope: ${files.length} changed files; rust ${j.rust}, wasm ${j.wasm}, desktop-bridge ${j.bridge}, web tests ${j.web}` +
      (j.outside.length ? ` (outside every package: ${j.outside.slice(0, 5).join(', ')}${j.outside.length > 5 ? ', ...' : ''})` : ''))
    return 0
  }
  // web: pnpm picks the packages; the root package (files outside every package) is never one of them here
  const pnpmArgs = webArgs(files, base, t)
  const listed = JSON.parse(execFileSync('pnpm', [...pnpmArgs, 'ls', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }) || '[]')
  const names = listed.filter((p) => posix.normalize(p.path.split('\\').join('/')) !== posix.normalize(root.split('\\').join('/'))).map((p) => p.name).sort()
  const w = web(names)
  console.log(`packages=${w.packages.join(' ')}\nengine=${w.engine}\nchromium=${w.chromium}`)
  console.error(`pr-scope: pnpm ${pnpmArgs.join(' ')}\npr-scope: tests ${names.length ? names.join(', ') : 'no package'}; engine ${w.engine}, chromium ${w.chromium}`)
  return 0
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)))
