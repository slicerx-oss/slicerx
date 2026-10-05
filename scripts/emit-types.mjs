// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes self-contained type declarations for a package that is published on its own.
//
//   node scripts/emit-types.mjs <package dir> <name>=<entry.ts>... [--out <dir>] [--keep <@slicerx/name>]...
//
// --keep leaves imports of a workspace package that is published on its own (a dependency of
// this one) as they are, so the declarations use that package's own types.
//
// The workspace packages export TypeScript sources and are not all published, so declarations
// that import '@slicerx/...' would not resolve for someone who installs one package from npm.
// This runs tsc in declaration-only mode over the entries, keeps the repository layout under
// <out>/src-types/, rewrites every '@slicerx/<package>' import to a relative path inside that
// tree, and writes <out>/<name>.d.ts for each entry. Default <out>: <package dir>/dist.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const oi = args.indexOf('--out')
const keep = new Set(args.filter((_, i) => args[i - 1] === '--keep'))
const pkgDir = resolve(args[0] ?? '')
const out = resolve(oi >= 0 ? args[oi + 1] : join(pkgDir, 'dist'))
const entries = args
  .slice(1)
  .filter((a) => !a.startsWith('--') && a.includes('='))
  .map((a) => {
    const [name, file] = a.split('=')
    return { name, file: resolve(pkgDir, file) }
  })
if (!existsSync(join(pkgDir, 'package.json')) || entries.length === 0) {
  console.error('usage: node scripts/emit-types.mjs <package dir> <name>=<entry.ts>... [--out <dir>]')
  process.exit(2)
}

// Every workspace package: name to directory, with its exports map.
const workspace = new Map()
function scan(dir, depth) {
  if (depth > 3 || !existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
    const d = join(dir, e.name)
    const pj = join(d, 'package.json')
    if (existsSync(pj)) {
      const p = JSON.parse(readFileSync(pj, 'utf8'))
      if (typeof p.name === 'string' && p.name.startsWith('@slicerx/')) workspace.set(p.name, { dir: d, exports: p.exports ?? {} })
    }
    scan(d, depth + 1)
  }
}
scan(join(repo, 'packages'), 0)

/** The source file a '@slicerx/...' specifier points at, from the package's exports map. */
function sourceOf(spec) {
  const m = /^(@slicerx\/[^/]+)(\/.*)?$/.exec(spec)
  if (!m) return null
  const pkg = workspace.get(m[1])
  if (!pkg) return null
  const key = '.' + (m[2] ?? '')
  let target = typeof pkg.exports === 'string' ? (key === '.' ? pkg.exports : null) : pkg.exports[key]
  if (target === undefined) {
    // A pattern export such as "./*": "./src/*.ts".
    for (const [k, v] of Object.entries(pkg.exports)) {
      if (k.includes('*') && key.startsWith(k.split('*')[0]) && key.endsWith(k.split('*')[1])) {
        target = v.replace('*', key.slice(k.split('*')[0].length, key.length - k.split('*')[1].length))
      }
    }
  }
  if (target && typeof target === 'object') target = target.types ?? target.import ?? target.default
  return typeof target === 'string' ? join(pkg.dir, target) : null
}

// Node's types only for packages that use them (the browser packages do not install them).
const nodeTypes = existsSync(join(pkgDir, 'node_modules', '@types', 'node')) ? ['node'] : []

const paths = {}
for (const [name, { dir, exports }] of workspace) {
  if (keep.has(name)) continue
  const map = typeof exports === 'string' ? { '.': exports } : exports
  for (const [key, value] of Object.entries(map)) {
    const target = typeof value === 'object' && value ? (value.types ?? value.import ?? value.default) : value
    if (typeof target === 'string' && /\.(tsx?|json)$/.test(target.replace('*', 'x'))) paths[name + key.slice(1)] = [join(dir, target)]
  }
}

// 1. Declarations for the entries and everything they import from the workspace.
const tmp = mkdtempSync(join(tmpdir(), 'sx-types-'))
const tsconfig = join(tmp, 'tsconfig.json')
writeFileSync(
  tsconfig,
  JSON.stringify({
    extends: join(repo, 'tsconfig.base.json'),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: repo,
      outDir: join(tmp, 'out'),
      types: nodeTypes,
      typeRoots: [join(pkgDir, 'node_modules', '@types'), join(repo, 'node_modules', '@types')],
      skipLibCheck: true,
      jsx: 'react-jsx',
      // Resolve workspace packages to their sources, so tsc emits their declarations too (it
      // emits nothing for files it reaches through node_modules).
      paths,
    },
    // The entries, plus ambient declarations next to them (such as a '*?raw' module).
    files: [
      ...entries.map((e) => e.file),
      ...[...new Set(entries.map((e) => dirname(e.file)))].flatMap((d) =>
        readdirSync(d)
          .filter((f) => f.endsWith('.d.ts'))
          .map((f) => join(d, f)),
      ),
    ],
  }),
)
const tsc = join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
try {
  execFileSync(process.execPath, [tsc, '-p', tsconfig], { cwd: pkgDir, stdio: 'inherit' })
} catch {
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}

// 2. Copy them under <out>/src-types and point workspace imports at the copies.
const typesRoot = join(out, 'src-types')
rmSync(typesRoot, { recursive: true, force: true })
mkdirSync(typesRoot, { recursive: true })
cpSync(join(tmp, 'out'), typesRoot, { recursive: true })
rmSync(tmp, { recursive: true, force: true })

const dts = (p) => p.replace(/\.(tsx?|mts)$/, '.d.ts')
const toPosix = (p) => p.split(sep).join('/')
let unresolved = 0
function rewrite(file) {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(/(from\s+|import\(\s*)(['"])(@slicerx\/[^'"]+)\2/g, (all, pre, q, spec) => {
    if (keep.has(spec.split('/').slice(0, 2).join('/'))) return all
    const src = sourceOf(spec)
    if (!src) {
      unresolved++
      console.error(`${relative(out, file)}: cannot resolve ${spec}`)
      return all
    }
    if (src.endsWith('.json')) {
      // A JSON module: ship the file itself next to the declarations.
      const copy = join(typesRoot, relative(repo, src))
      mkdirSync(dirname(copy), { recursive: true })
      cpSync(src, copy)
      let rel = toPosix(relative(dirname(file), copy))
      if (!rel.startsWith('.')) rel = './' + rel
      return `${pre}${q}${rel}${q}`
    }
    let rel = toPosix(relative(dirname(file), join(typesRoot, dts(relative(repo, src))))).replace(/\.d\.ts$/, '.js')
    if (!rel.startsWith('.')) rel = './' + rel
    return `${pre}${q}${rel}${q}`
  })
  // Relative imports written with a .ts or .tsx extension point at the emitted .d.ts files.
  const fixed = next.replace(/(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+?)\.tsx?\2/g, '$1$2$3.js$2')
  if (fixed !== text) writeFileSync(file, fixed)
}
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.d.ts')) rewrite(p)
  }
}
walk(typesRoot)

// 3. One declaration file per entry.
for (const e of entries) {
  let rel = toPosix(relative(out, join(typesRoot, dts(relative(repo, e.file))))).replace(/\.d\.ts$/, '.js')
  if (!rel.startsWith('.')) rel = './' + rel
  writeFileSync(join(out, `${e.name}.d.ts`), `export * from '${rel}'\n`)
}
if (unresolved) {
  console.error(`emit-types: ${unresolved} workspace import(s) could not be resolved`)
  process.exit(1)
}

// 4. Check the result the way a consumer sees it: only the declarations and the package's npm
// dependencies, no workspace sources.
const check = mkdtempSync(join(tmpdir(), 'sx-types-check-'))
writeFileSync(
  join(check, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      jsx: 'react-jsx',
      types: nodeTypes,
      typeRoots: [join(pkgDir, 'node_modules', '@types'), join(repo, 'node_modules', '@types')],
    },
    files: entries.map((e) => join(out, `${e.name}.d.ts`)),
  }),
)
try {
  execFileSync(process.execPath, [tsc, '-p', join(check, 'tsconfig.json')], { cwd: pkgDir, stdio: 'inherit' })
} catch {
  console.error('emit-types: the declarations do not type-check on their own')
  process.exit(1)
} finally {
  rmSync(check, { recursive: true, force: true })
}
console.log(`emit-types: ${entries.map((e) => `${e.name}.d.ts`).join(', ')} in ${relative(repo, out)}`)
