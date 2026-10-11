// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs every model file reader on the format corpus (packages/geom/tests/corpus/corpus.json) and reports where they
// disagree and what each costs:
//
//   core   sx-core's loader (threemf.rs, mesh.rs; OBJ and AMF through sx-geom), what `sx` and the desktop slice
//   geom   sx-geom's import (STL, OBJ, AMF), what the app's geometry worker opens those formats with
//   app    the app's own readers (export/import3mf.ts for 3MF projects, export/stl-scan.ts for binary STL)
//   sx3mf  the sx3mf crate's package inspection (the sx: entries), what the library upload scan reads
//
//   node scripts/format-corpus/run.mjs [--private <dir>] [--repeats <n>] [--out <dir>] [--check] [--write-known]
//
// --private adds every model file in a folder that stays out of the repository (designs we may not commit). It
// builds the Rust reader (cargo, release) and runs the app's through tsx; run it on a build machine. The report is
// <out>/report.md (default target/format-corpus). --check compares the public corpus's disagreements with
// packages/geom/tests/corpus/known-differences.json and fails when they changed; --write-known records them.
// Peak memory is the reader process's maximum resident set (GNU time on Linux, BSD time on macOS) less that of
// the same process reading nothing.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const privateDir = opt('--private') ?? process.env['SX_CORPUS_PRIVATE']
const repeats = Number(opt('--repeats') ?? 3)
const out = resolve(opt('--out') ?? join(root, 'target/format-corpus'))
const knownFile = join(root, 'packages/geom/tests/corpus/known-differences.json')
const MODEL = /\.(stl|obj|amf|3mf|sx3mf)$/i

const manifest = JSON.parse(readFileSync(join(root, 'packages/geom/tests/corpus/corpus.json'), 'utf8'))
const files = manifest.files.map((f) => ({ path: join(root, f.path), name: f.path, made: f.made, public: true }))
if (privateDir) {
  for (const n of readdirSync(privateDir).filter((n) => MODEL.test(n)).sort()) files.push({ path: join(privateDir, n), name: `private/${n}`, made: 'private', public: false })
}

console.error('format-corpus: building the Rust reader')
execFileSync('cargo', ['build', '-q', '--release', '-p', 'sx-core', '--example', 'format_read'], { cwd: root, stdio: 'inherit' })
const target = process.env['CARGO_TARGET_DIR'] ?? join(root, 'target')
const rust = join(target, 'release/examples', process.platform === 'win32' ? 'format_read.exe' : 'format_read')
const tsx = join(root, 'packages/store/node_modules/.bin/tsx')
const tsScript = join(root, 'packages/app/scripts/format-read.ts')

const READERS = {
  core: { exts: ['stl', 'obj', 'amf', '3mf', 'sx3mf'], cmd: (f) => [rust, 'core', f, String(repeats)], none: [rust, 'none', '-'] },
  geom: { exts: ['stl', 'obj', 'amf'], cmd: (f) => [rust, 'geom', f, String(repeats)], none: [rust, 'none', '-'] },
  app: { exts: ['stl', '3mf', 'sx3mf'], cmd: (f) => [tsx, tsScript, f, String(repeats)], none: [tsx, tsScript, '--none'] },
  sx3mf: { exts: ['3mf', 'sx3mf'], cmd: (f) => [rust, 'sx3mf', f, String(repeats)], none: [rust, 'none', '-'] },
}

/** Runs a command under time(1); its JSON line and its peak resident set in KB. */
function timed(argv) {
  const mac = process.platform === 'darwin'
  const r = spawnSync('/usr/bin/time', mac ? ['-l', ...argv] : ['-f', 'SXRSS %M', ...argv], { cwd: join(root, 'packages/app'), encoding: 'utf8', maxBuffer: 1 << 26 })
  const rss = mac ? Number(/(\d+)\s+maximum resident set size/.exec(r.stderr)?.[1] ?? 0) / 1024 : Number(/SXRSS (\d+)/.exec(r.stderr)?.[1] ?? 0)
  const line = r.stdout.trim().split('\n').pop() ?? ''
  try {
    return { json: JSON.parse(line), rssKb: rss }
  } catch {
    return { json: { ok: false, error: `no result (exit ${r.status}): ${r.stderr.trim().split('\n').slice(-2).join(' ')}` }, rssKb: rss }
  }
}

// `none` writes no file name; the Rust reader reads its argument, so give it a real one
const baseline = {}
for (const [name, r] of Object.entries(READERS)) {
  const argv = r.none.map((a) => (a === '-' ? join(root, 'packages/geom/tests/corpus/box-ascii.stl') : a))
  baseline[name] = timed(argv).rssKb
}

const PART_FIELDS = ['name', 'type', 'slot', 'triangles']
const PAINT = ['color', 'seam', 'support', 'fuzzy']
const TYPE_ORDER = { normal: 0, negative: 1, modifier: 2, support_blocker: 3, support_enforcer: 4 }

/** Every comparable value of one reader's summary, keyed by where it is. */
function facts(model) {
  const f = new Map()
  if (!model) return f
  if (model.plates) {
    f.set('plates', model.plates.length)
    for (const [pi, pl] of model.plates.entries()) {
      f.set(`plate ${pi + 1} objects`, pl.objects.length)
      for (const [oi, o] of pl.objects.entries()) {
        const at = `plate ${pi + 1} object ${oi + 1}`
        f.set(`${at} name`, o.name)
        f.set(`${at} extent`, o.extent.map((v) => v.toFixed(1)).join(' x '))
        f.set(`${at} parts`, o.parts.length)
        const types = {}
        for (const p of o.parts) types[p.type] = (types[p.type] ?? 0) + 1
        f.set(`${at} part types`, Object.entries(types).sort().map(([k, v]) => `${k} ${v}`).join(', '))
        const parts = [...o.parts].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.triangles - b.triangles || a.slot - b.slot || String(a.name).localeCompare(String(b.name)))
        for (const [qi, p] of parts.entries()) {
          for (const k of PART_FIELDS) f.set(`${at} part ${qi + 1} ${k}`, p[k])
          for (const k of PAINT) if (p.paint?.[k]) f.set(`${at} part ${qi + 1} paint ${k}`, p.paint[k])
        }
        const paint = {}
        for (const p of o.parts) for (const k of PAINT) paint[k] = (paint[k] ?? 0) + (p.paint?.[k] ?? 0)
        for (const k of PAINT) f.set(`${at} painted ${k}`, paint[k])
      }
    }
  }
  const m = model.meta ?? {}
  // the key names, so a difference can say which; a file without settings reads as none
  if (m.settingsKeys?.length) f.set('settings keys', [...m.settingsKeys].sort().join(' '))
  if (m.sx) for (const k of ['listing', 'creator']) if (m.sx[k] != null) f.set(`sx ${k}`, m.sx[k])
  return f
}

const results = []
for (const file of files) {
  const ext = extname(file.path).slice(1).toLowerCase()
  const row = { ...file, bytes: statSync(file.path).size, readers: {} }
  for (const [name, r] of Object.entries(READERS)) {
    if (!r.exts.includes(ext)) continue
    const { json, rssKb } = timed(r.cmd(file.path))
    row.readers[name] = { ...json, peakMb: Math.max(0, (rssKb - baseline[name]) / 1024) }
  }
  results.push(row)
  console.error(`format-corpus: ${file.name}`)
}

/** Disagreements in one file: a fact two readers both state differently, or a reader that fails where another reads. */
function disagreements(row) {
  const out = []
  // a reader that hands a file to another (the app's ASCII STL goes to sx-geom) answers with no model
  const ok = Object.entries(row.readers).filter(([, r]) => r.ok && r.model)
  const failed = Object.entries(row.readers).filter(([, r]) => !r.ok)
  if (ok.length && failed.length) for (const [n, r] of failed) out.push({ key: `${n} fails`, values: { [n]: r.error } })
  const all = Object.fromEntries(ok.map(([n, r]) => [n, facts(r.model)]))
  const keys = new Set(Object.values(all).flatMap((m) => [...m.keys()]))
  for (const key of keys) {
    const values = {}
    for (const [n, m] of Object.entries(all)) if (m.has(key)) values[n] = m.get(key)
    // only the readers that read this kind of fact take part: sx3mf reads no geometry, geom no settings
    const kind = key.startsWith('sx ') ? ['sx3mf', 'app'] : key.startsWith('settings') ? ['core', 'app'] : ['core', 'geom', 'app']
    const readers = kind.filter((n) => n in all)
    for (const n of readers) if (!(n in values)) values[n] = key.includes(' paint ') || key.includes(' painted ') ? 0 : '(none)'
    if (new Set(readers.map((n) => String(values[n]))).size > 1) out.push({ key, values })
  }
  return out
}

const fmt = (v) => (v === undefined ? '' : String(v).replace(/\|/g, '/'))
const short = (v) => (String(v).length > 60 ? `${String(v).slice(0, 57)}...` : String(v))

/** One line per kind of difference in a file, for the summary table. */
function summarize(d) {
  const lines = []
  const say = (what, x) => lines.push(`${what}: ${Object.entries(x.values).map(([n, v]) => `${n} ${short(v)}`).join(', ')}`)
  const first = (re) => d.find((x) => re.test(x.key))
  for (const x of d.filter((x) => x.key.endsWith(' fails'))) lines.push(`${x.key}: ${short(Object.values(x.values)[0])}`)
  const settings = first(/^settings keys$/)
  if (settings) {
    const sets = Object.fromEntries(Object.entries(settings.values).map(([n, v]) => [n, new Set(v === '(none)' ? [] : String(v).split(' '))]))
    const parts = Object.entries(sets).map(([n, set]) => {
      const only = [...set].filter((k) => Object.entries(sets).some(([m, o]) => m !== n && !o.has(k)))
      return `${n} ${set.size} keys${only.length ? ` (only ${n}: ${only.slice(0, 3).join(', ')}${only.length > 3 ? ', ...' : ''})` : ''}`
    })
    lines.push(`settings: ${parts.join('; ')}`)
  }
  for (const [what, re] of [['plates', /^plates$|objects$/], ['part types', /part types$/], ['parts', / parts$/], ['paint', / painted /], ['slots', / slot$/], ['triangles', / triangles$/], ['size', / extent$/], ['object names', /object \d+ name$/], ['part names', /part \d+ name$/], ['sx marks', /^sx /]]) {
    const x = first(re)
    if (x) say(what, x)
  }
  return lines
}
const known = {}
let summary = '| File | Made by | Where the readers disagree |\n| --- | --- | --- |\n'
let detail = '| File | Where | core | geom | app | sx3mf |\n| --- | --- | --- | --- | --- | --- |\n'
for (const row of results) {
  const d = disagreements(row)
  if (row.public) known[row.name] = d.map((x) => x.key).sort()
  const file = row.name.replace(/^.*\//, '')
  summary += `| ${file} | ${row.made} | ${summarize(d).map(fmt).join('<br>') || 'agree'} |\n`
  for (const x of d) detail += `| ${file} | ${x.key} | ${['core', 'geom', 'app', 'sx3mf'].map((n) => fmt(short(x.values[n] ?? ''))).join(' | ')} |\n`
}
let md = `# Format corpus\n\n${results.length} files, readers: core, geom, app, sx3mf. Times are the first read and the fastest of ${repeats}, peak memory is over each reader's own idle process.\n\n## Summary\n\n${summary}\n## Every difference\n\n${detail}`
md += `\n## Speed and memory\n\n| File | Size | Reader | First ms | Fastest ms | Peak MB |\n| --- | --- | --- | --- | --- | --- |\n`
for (const row of results) {
  for (const [n, r] of Object.entries(row.readers)) {
    md += `| ${row.name.replace(/^.*\//, '')} | ${(row.bytes / 1024).toFixed(0)} KB | ${n} | ${r.ok ? r.firstMs.toFixed(1) : 'fails'} | ${r.ok ? r.minMs.toFixed(1) : ''} | ${r.peakMb.toFixed(1)} |\n`
  }
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'report.md'), md)
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1))
console.log(md)

if (args.includes('--write-known')) writeFileSync(knownFile, JSON.stringify(known, null, 2) + '\n')
if (args.includes('--check')) {
  const was = existsSync(knownFile) ? JSON.parse(readFileSync(knownFile, 'utf8')) : {}
  const changed = Object.keys({ ...was, ...known }).filter((k) => JSON.stringify(was[k] ?? []) !== JSON.stringify(known[k] ?? []))
  if (changed.length) {
    console.error(`format-corpus: the readers' disagreements changed in ${changed.map((c) => basename(c)).join(', ')}; check the report, then --write-known`)
    process.exit(1)
  }
  console.error('format-corpus: disagreements as recorded')
}
