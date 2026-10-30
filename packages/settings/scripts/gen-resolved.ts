// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds packages/profiles/resolved/<brand>.json: for every printer model, the printer, filament and process settings
// OrcaSlicer 2.4.2 resolves for the maker's own system presets (the config block at the end of its G-code, with the
// full `inherits` chain and the extruder variant already applied), keeping only the keys whose value differs from
// our schema default. The dumps come from packages/core/bench/compare/resolved_dump.py, run on a machine with OrcaSlicer 2.4.2.
// Printer G-code (start, end, layer change, filament change, pause, time lapse) is left out: it ships in
// packages/profiles/gcode.json. The filament start and end G-code stay with the filament.
// Run: npx tsx scripts/gen-resolved.ts <dump-dir>   (the full dump directory: the per-nozzle .nNN.json files too; the script
// refuses to write when the nozzle maps are missing, a quality tier the maker has a preset for is missing, or the output
// shrinks by more than 10 percent)
// Or: npx tsx scripts/gen-resolved.ts <dump-dir> --only <model>,<model>   (a dump of those models only, every tier and
// nozzle: their entries are replaced and every other model is kept as it is in the current files)
// Last, the Bambu Lab output gets packages/profiles/overlays/bbl-2.8.json (Bambu Studio 2.8's values for the settings the
// engine reads, js/overlay.ts), so a regeneration keeps them. scripts/apply-overlay.ts applies it to filaments/BBL.json.
// The Prusa output gets packages/profiles/overlays/prusa-mk4is.json (the MK4 IS lift and retraction for the stock MK4) the
// same way, and apply-overlay.ts also writes it to machine.json. The list is MAKER_OVERLAYS in js/overlay.ts.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { defaultConfig } from '../js/defaults'
import { importFlat, PROFILE_META_KEYS } from '../js/import'
import { settingDef } from '../js/schema'
import { sameValue } from '../js/diff'
import { applyResolvedOverlay, MAKER_OVERLAYS, type MakerOverlay, type ResolvedBrand } from '../js/overlay'
import machineJson from '../../profiles/machine.json'
import printersJson from '../profiles/printers.json'
import speedsJson from '../../profiles/process-speeds.json'

const dir = process.argv[2]
if (!dir) throw new Error('usage: gen-resolved.ts <dump-dir> [--only <model>,<model>]')
const onlyAt = process.argv.indexOf('--only')
const ONLY = onlyAt > 0 ? new Set((process.argv[onlyAt + 1] ?? '').split(',').filter(Boolean)) : undefined
if (ONLY && ONLY.size === 0) throw new Error('--only needs a comma separated list of model ids')
/** The maker's process presets per model and quality tier at the default nozzle (the tiers the dump has a preset for). */
const SPEEDS = (speedsJson as unknown as { models: Record<string, Record<string, string>> }).models
const MACHINES = (machineJson as unknown as { models: Record<string, { orca: { vendor: string; profile: string } }> }).models
const PRINTERS = (printersJson as unknown as { printers: { id: string; brand: string }[] }).printers
const defaults = defaultConfig() as Record<string, unknown>

// Orca writes a line break as backslash n, a quote as backslash quote and a backslash as two.
const unescape = (v: string): string => v.replace(/\\(.)/g, (m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === '"' ? '"' : c === '\\' ? '\\' : m))
const clean = (v: string): string => unescape(v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v)
const KEEP_GCODE = new Set(['filament_start_gcode', 'filament_end_gcode'])
const EXCLUDE = (k: string): boolean => (k.endsWith('gcode') && !KEEP_GCODE.has(k)) || PROFILE_META_KEYS.has(k) || k === 'printer_notes' || k === 'filament_notes' || /^default_(print|filament)_profile$/.test(k) || /_settings_id$/.test(k)

type Cfg = Record<string, unknown>
const parse = (file: string): Cfg => {
  const raw = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Record<string, string>
  return importFlat(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]))).config as Cfg
}
const pick = (cfg: Cfg, section: string): Cfg => {
  const out: Cfg = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (EXCLUDE(k) || settingDef(k)?.section !== section) continue
    if (!sameValue(v as never, defaults[k] as never)) out[k] = v
  }
  return out
}
const diff = (cfg: Cfg, base: Cfg): { set: Cfg; unset: string[] } => {
  const set: Cfg = {}
  for (const [k, v] of Object.entries(cfg)) if (!sameValue(v as never, base[k] as never)) set[k] = v
  return { set, unset: Object.keys(base).filter((k) => !(k in cfg)) }
}

const files = readdirSync(dir).filter((f) => f.startsWith('orca-') && f.endsWith('.json'))
// model -> nozzle ('' for the default nozzle) -> tier -> file
const byModel = new Map<string, Map<string, Map<string, string>>>()
for (const f of files) {
  const m = /^orca-(.+?)\.([a-z_]+)(?:\.n([0-9.]+))?\.json$/.exec(f)
  if (!m || (ONLY && !ONLY.has(m[1]!))) continue
  const nozzles = byModel.get(m[1]!) ?? new Map<string, Map<string, string>>()
  const tiers = nozzles.get(m[3] ?? '') ?? new Map<string, string>()
  nozzles.set(m[3] ?? '', tiers.set(m[2]!, f))
  byModel.set(m[1]!, nozzles)
}
for (const id of ONLY ?? []) if (!byModel.get(id)?.get('')) throw new Error(`--only ${id}: the dump directory has no orca-${id}.<tier>.json`)

interface Resolved { orca: { vendor: string; profile: string; process: string; filament: string; filamentId?: string } | null; base: string; machine: Cfg; filament: Cfg; process: Record<string, unknown> }

// the maker filament's preset id (GFA00 and the like), which bambu printers read per tray; orca writes it as `filament_ids`
const filamentId = (file: string): string => {
  const raw = (JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Record<string, string>)['filament_ids'] ?? ''
  return clean(raw.split(';')[0] ?? '').replace(/^"|"$/g, '')
}

function resolve(model: string, tiers: Map<string, string>): Resolved | undefined {
  const first = tiers.has('standard') ? 'standard' : [...tiers.keys()][0]
  if (!first) return undefined
  const stdFile = tiers.get(first)!
  const stdCfg = parse(stdFile)
  const names = existsSync(`${dir}/${stdFile.replace(/\.json$/, '.names')}`) ? (JSON.parse(readFileSync(`${dir}/${stdFile.replace(/\.json$/, '.names')}`, 'utf8')) as { vendor: string; machine: string; process: string; filament: string }) : undefined
  const stdProcess = pick(stdCfg, 'process')
  const process: Record<string, unknown> = { [first]: stdProcess }
  for (const [tier, file] of [...tiers].sort()) if (tier !== first) process[tier] = diff(pick(parse(file), 'process'), stdProcess)
  const fromMachine = MACHINES[model]?.orca
  const id = filamentId(stdFile)
  const orca = names ? { vendor: names.vendor, profile: names.machine, process: names.process, filament: names.filament } : fromMachine ? { ...fromMachine, process: '', filament: '' } : null
  return { orca: orca && id ? { ...orca, filamentId: id } : orca, base: first, machine: pick(stdCfg, 'printer'), filament: pick(stdCfg, 'filament'), process }
}

const brands = new Map<string, Record<string, unknown>>()
let kept = 0
for (const [model, nozzles] of [...byModel].sort()) {
  const brand = PRINTERS.find((p) => p.id === model)?.brand
  const main = nozzles.get('')
  if (!brand || !main) continue
  const entry = resolve(model, main)
  if (!entry) continue
  const others: Record<string, Resolved> = {}
  for (const [n, tiers] of [...nozzles].sort()) {
    if (n === '') continue
    const r = resolve(model, tiers)
    if (r) others[n] = r
  }
  const file = brands.get(brand) ?? { orcaApp: '2.4.2', models: {} }
  ;(file['models'] as Record<string, unknown>)[model] = { ...entry, ...(Object.keys(others).length ? { nozzles: others } : {}) }
  brands.set(brand, file)
  kept++
}
// The maker overlays, applied last.
for (const o of MAKER_OVERLAYS) {
  const data = brands.get(o.brand)
  if (!data) continue
  const full = JSON.parse(readFileSync(new URL(`../../profiles/${o.path}`, import.meta.url), 'utf8')) as MakerOverlay
  // With --only, the overlay's entries for the regenerated models; the kept models have theirs already.
  const mine = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([m]) => !ONLY || ONLY.has(m)))
  const overlay: MakerOverlay = { ...full, machine: mine(full.machine), process: mine(full.process) }
  applyResolvedOverlay(data as unknown as ResolvedBrand, overlay, (model) => (printersJson as unknown as { printers: { id: string; defaultNozzle: number }[] }).printers.find((p) => p.id === model)?.defaultNozzle ?? 0.4)
}
// The models the dump wrote, before --only adds the kept ones from the current files.
const fresh = new Map([...brands].map(([brand, data]) => [brand, new Set(Object.keys(data['models'] as Record<string, unknown>))]))
if (ONLY) {
  for (const [brand, data] of brands) {
    const path = new URL(`../../profiles/resolved/${brand}.json`, import.meta.url)
    const old = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> & { models: Record<string, unknown> }) : undefined
    if (old) brands.set(brand, { ...old, models: { ...old.models, ...(data['models'] as Record<string, unknown>) } })
  }
}
// Guards: a dump directory without the per-nozzle files (orca-<model>.<tier>.n<size>.json) silently drops the nozzle maps. Refuse
// to write when a printer that has a nozzle map in the current files loses it, when no per-nozzle dump is present at all while
// Orca has nozzle variants, when a nozzle variant Orca lists for a printer (packages/profiles/machine.json) is missing, or when the output
// shrinks by more than 10 percent. Also when a model's default nozzle lacks a quality tier the maker has a preset for
// (packages/profiles/process-speeds.json lists them), or is based on another tier while it has a Standard: a dump that skipped a
// preset (a renamed one, say) then left the app printing every goal with one tier's process.
{
  const problems: string[] = []
  let before = 0
  let after = 0
  let anyNozzleDump = false
  for (const f of files) if (/\.n[0-9.]+\.json$/.test(f)) anyNozzleDump = true
  const orcaHasVariants = Object.values(MACHINES).some((m) => Object.keys((m as { nozzles?: Record<string, unknown> }).nozzles ?? {}).length > 0)
  if (orcaHasVariants && !anyNozzleDump) problems.push('the dump directory has no per-nozzle files (orca-<model>.<tier>.n<size>.json), but Orca has nozzle variants')
  for (const [brand, data] of brands) {
    const path = new URL(`../../profiles/resolved/${brand}.json`, import.meta.url)
    const old = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { models: Record<string, { nozzles?: unknown }> }) : undefined
    if (old) before += readFileSync(path, 'utf8').length
    after += (JSON.stringify(data) + '\n').length
    for (const [model, e] of Object.entries(data['models'] as Record<string, { nozzles?: unknown }>)) {
      if (old?.models[model]?.nozzles && !e.nozzles) problems.push(`${brand}/${model} has a nozzle map in the current file but none in the output`)
    }
  }
  // Orca's own nozzle variants (packages/profiles/machine.json lists them per model) must all be in the output.
  const size = (n: string): number => Number(n)
  for (const [brand, data] of brands) {
    for (const [model, e] of Object.entries(data['models'] as Record<string, { nozzles?: Record<string, unknown>; base: string; process: Record<string, unknown> }>)) {
      if (!fresh.get(brand)?.has(model)) continue
      const tiers = Object.keys(SPEEDS[model] ?? {})
      const lacking = tiers.filter((t) => !(t in e.process))
      if (lacking.length > 0) problems.push(`${brand}/${model}: the maker has ${lacking.join(', ')} presets that the output lacks`)
      if (tiers.includes('standard') && e.base !== 'standard') problems.push(`${brand}/${model}: the output is based on ${e.base}, not standard`)
      const want = Object.keys((MACHINES[model] as { nozzles?: Record<string, unknown> } | undefined)?.nozzles ?? {}).map(size)
      const have = new Set(Object.keys(e.nozzles ?? {}).map(size))
      const missing = want.filter((n) => !have.has(n))
      if (missing.length > 0) problems.push(`${brand}/${model}: Orca has nozzle variants ${missing.join(', ')} that the output lacks`)
    }
  }
  if (before > 0 && after < before * 0.9) problems.push(`the output is ${after} bytes, more than 10 percent below the current ${before}`)
  if (problems.length > 0) {
    console.error(`gen-resolved: refusing to write.\n- ${problems.join('\n- ')}\nUse the full dump directory, with the per-nozzle files.`)
    process.exit(1)
  }
}
mkdirSync(new URL('../../profiles/resolved/', import.meta.url), { recursive: true })
for (const [brand, data] of brands) writeFileSync(new URL(`../../profiles/resolved/${brand}.json`, import.meta.url), JSON.stringify(data) + '\n')
console.log(`resolved: ${kept} printers in ${brands.size} files`)
