// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds profiles/stock-gcode.json: fingerprints of every printer G-code text the makers shipped for each printer
// model in the history of Bambu Studio and OrcaSlicer, so a project saved by any of their versions with stock G-code
// is recognized as stock (js/gcode-review.ts). Only fingerprints are kept, never the text: the first 128 bits of the
// SHA-256 of the text with line breaks as \n, trailing spaces and blank lines dropped.
//
// For each model of packages/profiles/machine.json that has the makers' own G-code, every commit that touched its
// machine preset files (each nozzle's, the template files they include, the presets they inherit) is resolved the way
// the apps resolve a preset: the file's own value, then its includes, then its parent. Filament start and end G-code
// is collected per vendor from every version of every filament preset of that vendor (and Orca's filament library).
//
// Run: node scripts/gen-stock-gcode.mjs --bambu <BambuStudio clone> --orca <OrcaSlicer clone>
// Both clones need their full history of resources/profiles (a blobless clone works: fetch the profile blobs first).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const here = (p) => new URL(p, import.meta.url)
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const repos = [
  ['bambuStudio', arg('--bambu')],
  ['orcaSlicer', arg('--orca')],
].filter(([, dir]) => dir)
if (repos.length === 0) throw new Error('usage: gen-stock-gcode.mjs --bambu <dir> --orca <dir>')

const MACHINES = JSON.parse(readFileSync(here('../../profiles/machine.json'), 'utf8')).models
const GCODE = JSON.parse(readFileSync(here('../../profiles/gcode.json'), 'utf8'))
// The printer G-code keys js/gcode-review.ts reads; filament G-code is collected per vendor.
const MACHINE_KEYS = ['machine_start_gcode', 'machine_end_gcode', 'before_layer_change_gcode', 'layer_change_gcode', 'change_filament_gcode', 'machine_pause_gcode', 'template_custom_gcode', 'time_lapse_gcode', 'toolchange_gcode', 'wrapping_detection_gcode', 'file_start_gcode', 'extruder_start_gcode', 'printing_by_object_gcode', 'change_extrusion_role_gcode']
const FILAMENT_KEYS = ['filament_start_gcode', 'filament_end_gcode', 'filament_change_extrusion_role_gcode']

const normalize = (t) =>
  t
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .filter((l) => l.trim())
    .join('\n')
const fingerprint = (t) => createHash('sha256').update(normalize(t)).digest('hex').slice(0, 32)

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
}

/** Every version of a file: [commit time, blob] from newest to oldest. */
function versions(dir, path) {
  const out = []
  const log = git(dir, 'log', '--format=%ct', '--raw', '--no-abbrev', '--no-renames', 'HEAD', '--', path)
  let time = 0
  for (const line of log.split('\n')) {
    if (/^\d+$/.test(line)) time = Number(line)
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([AMD])\t/.exec(line)
    if (m) out.push([time, m[2] === 'D' ? null : m[1]])
  }
  return out
}

const blobCache = new Map()
function readBlob(dir, blob) {
  const id = `${dir}:${blob}`
  if (!blobCache.has(id)) {
    let v = null
    try {
      v = JSON.parse(git(dir, 'cat-file', 'blob', blob))
    } catch {
      v = null
    }
    blobCache.set(id, v)
  }
  return blobCache.get(id)
}

/** Text of a G-code value: a string, or the first entry of a list. */
const textOf = (v) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined)

function machineFingerprints(dir, vendor, profiles) {
  const base = `resources/profiles/${vendor}/machine/`
  const fileVersions = new Map()
  const vers = (name) => {
    if (!fileVersions.has(name)) fileVersions.set(name, versions(dir, `${base}${name}.json`))
    return fileVersions.get(name)
  }
  // The file's content at a time: its newest version no later than it.
  const at = (name, t) => {
    const v = vers(name).find(([time]) => time <= t)
    return v && v[1] ? readBlob(dir, v[1]) : null
  }
  // Every file a preset can read from in any version: its includes and parents, transitively.
  const closure = new Set()
  const walk = (name) => {
    if (closure.has(name)) return
    closure.add(name)
    for (const [, blob] of vers(name)) {
      const j = blob ? readBlob(dir, blob) : null
      if (!j) continue
      for (const inc of Array.isArray(j.include) ? j.include : []) walk(inc)
      if (typeof j.inherits === 'string' && j.inherits) walk(j.inherits)
    }
  }
  for (const p of profiles) walk(p)
  const times = [...new Set([...closure].flatMap((n) => vers(n).map(([t]) => t)))].sort((a, b) => a - b)
  const resolve = (name, key, t, depth = 0) => {
    if (depth > 12) return undefined
    const j = at(name, t)
    if (!j) return undefined
    if (key in j) return textOf(j[key])
    for (const inc of Array.isArray(j.include) ? [...j.include].reverse() : []) {
      const i = at(inc, t)
      if (i && key in i) return textOf(i[key])
    }
    return typeof j.inherits === 'string' && j.inherits ? resolve(j.inherits, key, t, depth + 1) : undefined
  }
  const out = {}
  for (const t of times)
    for (const p of profiles) {
      if (!at(p, t)) continue
      for (const key of MACHINE_KEYS) {
        const text = resolve(p, key, t)
        if (text === undefined || !normalize(text)) continue
        ;(out[key] ??= new Set()).add(fingerprint(text))
      }
    }
  return out
}

function filamentFingerprints(dir, vendor) {
  const out = {}
  const log = git(dir, 'log', '--format=', '--raw', '--no-abbrev', '--no-renames', 'HEAD', '--', `resources/profiles/${vendor}/filament`)
  const blobs = new Set()
  for (const line of log.split('\n')) {
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [AM]\t.*\.json$/.exec(line)
    if (m) blobs.add(m[1])
  }
  for (const blob of blobs) {
    const j = readBlob(dir, blob)
    if (!j) continue
    for (const key of FILAMENT_KEYS) {
      const text = textOf(j[key])
      if (text !== undefined && normalize(text)) (out[key] ??= new Set()).add(fingerprint(text))
    }
  }
  return out
}

const merge = (into, from) => {
  for (const [k, set] of Object.entries(from)) for (const f of set) (into[k] ??= new Set()).add(f)
}
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, [...s].sort()]))

const models = {}
const vendors = {}
const sources = {}
for (const [name, dir] of repos) {
  sources[name] = git(dir, 'rev-parse', 'HEAD').trim()
  for (const [id, m] of Object.entries(MACHINES)) {
    if (!m.orca || !(GCODE.models[id] ?? '').startsWith('maker_')) continue
    // Bambu Studio has the Bambu Lab presets only.
    if (name === 'bambuStudio' && m.orca.vendor !== 'BBL') continue
    const profiles = [m.orca.profile, ...Object.values(m.nozzles ?? {}).map((n) => n.orcaProfile).filter(Boolean)]
    merge((models[id] ??= {}), machineFingerprints(dir, m.orca.vendor, profiles))
    process.stderr.write(`${name} ${id}: ${Object.values(models[id]).reduce((n, s) => n + s.size, 0)}\n`)
  }
  for (const vendor of new Set([...Object.values(MACHINES).flatMap((m) => (m.orca ? [m.orca.vendor] : [])), 'OrcaFilamentLibrary'])) {
    if (name === 'bambuStudio' && vendor !== 'BBL') continue
    merge((vendors[vendor] ??= {}), filamentFingerprints(dir, vendor))
  }
}

const doc = {
  comment:
    'Fingerprints of the printer G-code the makers shipped for each model in the history of Bambu Studio and OrcaSlicer, and of their filament presets per vendor: the first 128 bits of the SHA-256 of the text with line breaks as \\n, trailing spaces and blank lines dropped. Made by scripts/gen-stock-gcode.mjs; read by js/gcode-review.ts.',
  sources,
  models: Object.fromEntries(Object.entries(models).sort(([a], [b]) => a.localeCompare(b)).map(([id, keys]) => [id, sorted(keys)])),
  vendors: Object.fromEntries(Object.entries(vendors).sort(([a], [b]) => a.localeCompare(b)).map(([v, keys]) => [v, sorted(keys)])),
}
writeFileSync(here('../profiles/stock-gcode.json'), `${JSON.stringify(doc, null, 1)}\n`)
