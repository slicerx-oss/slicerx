// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A maker overlay: newer values from the maker's own app for settings the engine reads, written over the generated preset
// data as its last step. packages/profiles/overlays/bbl-2.8.json holds Bambu Studio 2.8's values for the Bambu Lab
// presets: filament presets by name (filaments/BBL.json), and the printer, default filament and process tiers of each
// model and nozzle (resolved/bambu-lab.json). packages/profiles/overlays/prusa-mk4is.json gives the stock Prusa MK4 the
// lift and retraction of the maker's MK4 IS profile, in resolved/prusa.json and in the printer settings of machine.json.
// packages/profiles/overlays/prusa-brim.json gives every Prusa process tier the maker's brim: whole loops, grown from the
// compensated first layer outline. packages/profiles/overlays/prusa-first-layer.json gives the Prusa MK4 and MINI the first
// layer line width and elephant foot compensation of the maker's Input Shaper print presets, for every nozzle and tier.
// packages/profiles/overlays/creality-ender-3-v3.json gives the plain Creality Ender-3 V3 the first layer and support line
// widths of the maker's process presets in its rows of process-speeds.json, which SlicerX's own process route reads on the
// 0.4 mm nozzle (processConfig and profileConfig, and process_config in Rust). The app's printer layer, preset import
// parents and the MCP server's tiers read the model's resolved presets instead, with the same widths.
// packages/profiles/overlays/bbl-2.9.json holds whole resolved entries from Bambu Studio 2.9's own presets for the Bambu Lab
// models OrcaSlicer 2.4.2 has no presets for (the H3C): an entry the brand file lacks is written from them, and one it
// has is left as it is.
// scripts/gen-resolved.ts applies them before writing, and scripts/apply-overlay.ts applies them to the shipped files, so
// a regeneration of any of these files keeps them. Applying one twice changes nothing.
import { sameValue } from './diff'
import { importFlat, PROFILE_META_KEYS } from './import'
import { defaultConfig, settingDef } from './schema'
import type { SettingValue } from '@slicerx/contracts/settings'

type Raw = Record<string, unknown>
interface Values { preset: string; values: Raw }
export interface MakerOverlay {
  comment?: string
  source?: Record<string, string>
  /** By preset name (`Bambu PLA Basic @BBL X1C`), in the profile's own format. */
  filament: Record<string, Raw>
  /** By printer model and nozzle size (`0.4`): the printer settings, and the default filament's. */
  machine: Record<string, Record<string, Values & { filament?: Values }>>
  /** By printer model, nozzle size and quality tier. */
  process: Record<string, Record<string, Record<string, Values>>>
  /**
   * Values for every process tier of every model and nozzle in the brand's data, under the tier's own `process`
   * values: what the maker's app does where its presets have no key at all.
   */
  every_process?: { comment?: string; values: Raw }
  /**
   * Values for the maker's process presets in process-speeds.json, by the preset's name there
   * (the stock 0.20mm Standard preset of the plain Ender-3 V3), raw: SlicerX's own process route (processConfig)
   * takes these rows over SlicerX's process for the model's tiers on the 0.4 mm nozzle.
   */
  process_presets?: Record<string, Raw>
  /**
   * Whole resolved entries, by printer model, for models the brand's generated data has none for: per nozzle size the
   * machine preset, its default filament and the process preset of each quality tier, values in the profile's own
   * format and resolved with their parents. A model the data already has keeps its entry.
   */
  models?: Record<string, ModelPresets>
}

/** The maker's stock presets of one model, for an entry written whole. */
export interface ModelPresets {
  orca: { vendor: string; profile: string; checked?: string }
  nozzles: Record<string, { machine: Values; filament: Values; process: Record<string, Values> }>
}

interface TierDiff { set: Raw; unset: string[] }
interface Part { base: string; machine: Raw; filament: Raw; process: Record<string, Raw | TierDiff> }
interface Entry extends Part { nozzles?: Record<string, Part> }
export interface ResolvedBrand { models: Record<string, Entry> }
export interface VendorData { families: Record<string, { base: Raw; variants: Record<string, Raw | undefined> }> }

/** The Bambu Lab overlay, relative to packages/profiles. */
export const BBL_OVERLAY = 'overlays/bbl-2.8.json'
/** The MK4 IS lift and retraction for the stock Prusa MK4, relative to packages/profiles. */
export const PRUSA_OVERLAY = 'overlays/prusa-mk4is.json'
/** The maker's brim (whole loops, from the compensated outline) for every Prusa process tier, relative to packages/profiles. */
export const PRUSA_BRIM_OVERLAY = 'overlays/prusa-brim.json'
/** The first layer line width and elephant foot compensation of the MK4 and MINI print presets, relative to packages/profiles. */
export const PRUSA_FIRST_LAYER_OVERLAY = 'overlays/prusa-first-layer.json'
/** The first layer and support line widths of the plain Ender-3 V3's process presets, relative to packages/profiles. */
export const CREALITY_V3_OVERLAY = 'overlays/creality-ender-3-v3.json'
/** Whole resolved entries from Bambu Studio 2.9's presets (the H3C), relative to packages/profiles. */
export const BBL_29_OVERLAY = 'overlays/bbl-2.9.json'

/**
 * Every maker overlay, in the order they apply: the brand whose resolved file it writes, the vendor filament file it
 * writes, whether it also writes the printer settings in machine.json, and whether it writes process presets in
 * process-speeds.json.
 */
export const MAKER_OVERLAYS: readonly { path: string; brand: string; filaments?: string; machineJson: boolean; processSpeeds?: boolean }[] = [
  // First, so the 2.8 values for every process tier reach the entries it writes.
  { path: BBL_29_OVERLAY, brand: 'bambu-lab', machineJson: false },
  { path: BBL_OVERLAY, brand: 'bambu-lab', filaments: 'filaments/BBL.json', machineJson: false },
  { path: PRUSA_OVERLAY, brand: 'prusa', machineJson: true },
  { path: PRUSA_BRIM_OVERLAY, brand: 'prusa', machineJson: false },
  { path: PRUSA_FIRST_LAYER_OVERLAY, brand: 'prusa', machineJson: false },
  { path: CREALITY_V3_OVERLAY, brand: 'creality', machineJson: false, processSpeeds: true },
]

const defaults = defaultConfig() as Raw

/** One raw value typed as the schema has it, under our name for the key. */
function typed(key: string, raw: unknown): [string, unknown] | undefined {
  const config = importFlat({ [key]: raw }).config as Raw
  const entries = Object.entries(config)
  return entries.length === 1 ? entries[0] : undefined
}

/** A list that repeats one value gets the length of the list it replaces, so the per-extruder shape stays. */
function shaped(value: unknown, old: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => sameValue(v as SettingValue, value[0] as SettingValue))) return value
  const n = Array.isArray(old) ? old.length : 1
  return Array.from({ length: n }, () => value[0])
}

/** Writes typed overlay values into one generated block, leaving out a key whose value is now the schema default. */
function writeTyped(block: Raw, values: Raw): void {
  for (const [k, raw] of Object.entries(values)) {
    const t = typed(k, raw)
    if (!t) throw new Error(`overlay: ${k} is not a setting the schema knows`)
    const [key, value] = t
    const v = shaped(value, block[key] ?? defaults[key])
    if (sameValue(v as SettingValue, defaults[key] as SettingValue)) delete block[key]
    else block[key] = v
  }
}

function applyPart(part: Part, machine: (Values & { filament?: Values }) | undefined, tiers: Record<string, Values> | undefined, every?: Raw): void {
  if (machine) writeTyped(part.machine, machine.values)
  if (machine?.filament) writeTyped(part.filament, machine.filament.values)
  if (!tiers && !every) return
  // Every tier whole, the overlay written over each, then the others stored again as differences from the base.
  const base = part.process[part.base] as Raw
  const whole: Record<string, Raw> = {}
  // The keys each tier already stores, in their order, so a second run writes the same file.
  const order: Record<string, string[]> = {}
  for (const [tier, p] of Object.entries(part.process)) {
    if (tier === part.base) { whole[tier] = { ...base }; continue }
    const d = p as TierDiff
    const w: Raw = { ...base, ...d.set }
    for (const k of d.unset) delete w[k]
    whole[tier] = w
    order[tier] = Object.keys(d.set)
  }
  for (const [tier, o] of Object.entries(tiers ?? {})) {
    if (!whole[tier]) throw new Error(`overlay: no ${tier} tier to write ${o.preset} over`)
  }
  for (const [tier, w] of Object.entries(whole)) writeTyped(w, { ...every, ...tiers?.[tier]?.values })
  const newBase = whole[part.base]!
  part.process[part.base] = newBase
  for (const [tier, w] of Object.entries(whole)) {
    if (tier === part.base) continue
    const set: Raw = {}
    for (const k of new Set([...(order[tier] ?? []), ...Object.keys(w)])) {
      if (k in w && !sameValue(w[k] as SettingValue, newBase[k] as SettingValue)) set[k] = w[k]
    }
    part.process[tier] = { set, unset: Object.keys(newBase).filter((k) => !(k in w)) }
  }
}

const KEEP_GCODE = new Set(['filament_start_gcode', 'filament_end_gcode'])
/** A preset's values of one section, typed, without the keys at the schema default: what gen-resolved.ts keeps of a dump. */
function sectionValues(raw: Raw, section: 'printer' | 'filament' | 'process'): Raw {
  const out: Raw = {}
  for (const [k, v] of Object.entries(importFlat(raw).config as Raw)) {
    if ((k.endsWith('gcode') && !KEEP_GCODE.has(k)) || PROFILE_META_KEYS.has(k) || k === 'printer_notes' || k === 'filament_notes' || /^default_(print|filament)_profile$/.test(k) || /_settings_id$/.test(k)) continue
    if (settingDef(k)?.section !== section) continue
    if (!sameValue(v as SettingValue, defaults[k] as SettingValue)) out[k] = v
  }
  return out
}

/** One nozzle's part of an entry written whole: Standard is the base tier, the others are stored as differences from it. */
function presetPart(n: ModelPresets['nozzles'][string], orca: Raw): Part & { orca: Raw } {
  const tiers = Object.keys(n.process)
  const base = tiers.includes('standard') ? 'standard' : tiers.sort()[0]!
  const std = sectionValues(n.process[base]!.values, 'process')
  const process: Record<string, Raw | TierDiff> = { [base]: std }
  for (const tier of tiers.sort()) {
    if (tier === base) continue
    const cfg = sectionValues(n.process[tier]!.values, 'process')
    const set: Raw = {}
    for (const [k, v] of Object.entries(cfg)) if (!sameValue(v as SettingValue, std[k] as SettingValue)) set[k] = v
    process[tier] = { set, unset: Object.keys(std).filter((k) => !(k in cfg)) }
  }
  const id = n.filament.values['filament_id']
  const filamentId = Array.isArray(id) ? String(id[0] ?? '') : String(id ?? '')
  return { orca: { ...orca, ...(filamentId ? { filamentId } : {}) }, base, machine: sectionValues(n.machine.values, 'printer'), filament: sectionValues(n.filament.values, 'filament'), process }
}

/** Writes the overlay's whole entries for the models the brand's data lacks, in place. */
export function addModelEntries(data: ResolvedBrand, overlay: MakerOverlay, defaultNozzle: (model: string) => number): void {
  let added = false
  for (const [model, presets] of Object.entries(overlay.models ?? {})) {
    if (data.models[model]) continue
    added = true
    const size = Object.keys(presets.nozzles).find((n) => Number(n) === defaultNozzle(model))
    if (!size) throw new Error(`overlay: ${model} has no ${defaultNozzle(model)} mm nozzle presets`)
    // The default nozzle names no process or filament, as the generated entries do; the others name theirs.
    const entry: Entry & { orca: Raw } = presetPart(presets.nozzles[size]!, { ...presets.orca, process: '', filament: '' })
    const others: Record<string, Part> = {}
    for (const [n, p] of Object.entries(presets.nozzles).sort(([a], [b]) => Number(a) - Number(b))) {
      if (n === size) continue
      others[n] = presetPart(p, { vendor: presets.orca.vendor, profile: p.machine.preset, process: p.process['standard']?.preset ?? '', filament: p.filament.preset })
    }
    if (Object.keys(others).length) entry.nozzles = others
    data.models[model] = entry
  }
  // In model order, as the generated files have them.
  if (added) data.models = Object.fromEntries(Object.entries(data.models).sort(([a], [b]) => a.localeCompare(b)))
}

/** Applies the overlay's printer, default filament and process values to a brand's resolved file, in place. */
export function applyResolvedOverlay(data: ResolvedBrand, overlay: MakerOverlay, defaultNozzle: (model: string) => number): void {
  addModelEntries(data, overlay, defaultNozzle)
  const every = overlay.every_process?.values
  const models = new Set([...Object.keys(overlay.machine), ...Object.keys(overlay.process), ...(every ? Object.keys(data.models) : [])])
  for (const model of models) {
    const entry = data.models[model]
    if (!entry) throw new Error(`overlay: no resolved data for ${model}`)
    const own = [String(defaultNozzle(model)), ...Object.keys(entry.nozzles ?? {})]
    const sizes = [...Object.keys(overlay.machine[model] ?? {}), ...Object.keys(overlay.process[model] ?? {}), ...(every ? own : [])]
    // One part per nozzle, however its size is written.
    const done = new Set<number>()
    for (const size of sizes) {
      if (done.has(Number(size))) continue
      done.add(Number(size))
      const part = Number(size) === defaultNozzle(model) ? entry : entry.nozzles?.[size]
      if (!part) throw new Error(`overlay: ${model} has no ${size} mm nozzle presets`)
      const key = (o: Record<string, unknown> | undefined) => Object.keys(o ?? {}).find((k) => Number(k) === Number(size))
      const m = overlay.machine[model]
      const p = overlay.process[model]
      applyPart(part, m?.[key(m) ?? ''], p?.[key(p) ?? ''], every)
    }
  }
}

/** Applies the overlay's filament values to a vendor file, in place: into each preset's own differences, raw. */
export function applyFilamentOverlay(file: VendorData, overlay: MakerOverlay): void {
  for (const [name, values] of Object.entries(overlay.filament)) {
    const at = name.lastIndexOf(' @')
    const family = at < 0 ? name : name.slice(0, at)
    const variant = at < 0 ? '' : name.slice(at + 2)
    const fam = file.families[family]
    const diff = fam?.variants[variant]
    if (!fam || diff === undefined) throw new Error(`overlay: no filament preset ${name}`)
    for (const [k, v] of Object.entries(values)) diff[k] = v
  }
}

/** process-speeds.json: the makers' process presets by name, raw, and the preset each model's tier takes. */
export interface SpeedsFile { presets: Record<string, Raw>; models: Record<string, Record<string, string>> }

/**
 * Applies the overlay's process preset values to process-speeds.json, in place and raw, keeping each preset's keys
 * sorted as the file has them. Every value must be a setting the schema knows.
 */
export function applyProcessPresetOverlay(file: SpeedsFile, overlay: MakerOverlay): void {
  for (const [name, values] of Object.entries(overlay.process_presets ?? {})) {
    const preset = file.presets[name]
    if (!preset) throw new Error(`overlay: no process preset ${name} in process-speeds.json`)
    for (const [k, v] of Object.entries(values)) {
      if (!typed(k, v)) throw new Error(`overlay: ${k} is not a setting the schema knows`)
      put(preset, k, v)
    }
  }
}

/** machine.json: the maker's printer settings per model, raw, for the default nozzle and the others' differences. */
export interface MachineFile { models: Record<string, { machine: Raw; nozzles: Record<string, { differs: Raw }> }> }

/** A schema default in the profiles' own format, so a nozzle can keep it when the default nozzle's value moves. */
function rawDefault(key: string): unknown {
  const v = defaults[key]
  const one = (x: unknown): string => {
    if (typeof x === 'number' || typeof x === 'string') return String(x)
    if (typeof x === 'boolean') return x ? '1' : '0'
    throw new Error(`overlay: no raw form for the default of ${key}`)
  }
  return Array.isArray(v) ? v.map(one) : one(v)
}

/** Sets a key and keeps the block's keys sorted, as machine.json has them. */
function put(block: Raw, key: string, value: unknown): void {
  block[key] = value
  const sorted = Object.keys(block).sort()
  const copy = { ...block }
  for (const k of sorted) delete block[k]
  for (const k of sorted) block[k] = copy[k]
}

/**
 * Applies the overlay's printer values to machine.json, in place and raw. A value for the default nozzle goes into the
 * model's own settings, and every other nozzle without a value of its own keeps the one it had, in its differences.
 */
export function applyMachineOverlay(file: MachineFile, overlay: MakerOverlay, defaultNozzle: (model: string) => number): void {
  for (const [model, sizes] of Object.entries(overlay.machine)) {
    const entry = file.models[model]
    if (!entry) throw new Error(`overlay: no machine settings for ${model}`)
    for (const [size, o] of Object.entries(sizes)) {
      if (Number(size) !== defaultNozzle(model)) {
        const nozzle = Object.entries(entry.nozzles).find(([n]) => Number(n) === Number(size))?.[1]
        if (!nozzle) throw new Error(`overlay: ${model} has no ${size} mm nozzle in machine.json`)
        for (const [k, v] of Object.entries(o.values)) put(nozzle.differs, k, v)
        continue
      }
      for (const [k, v] of Object.entries(o.values)) {
        if (!typed(k, v)) throw new Error(`overlay: ${k} is not a setting the schema knows`)
        if (JSON.stringify(entry.machine[k]) === JSON.stringify(v)) continue
        const before = entry.machine[k] ?? rawDefault(k)
        for (const [n, nozzle] of Object.entries(entry.nozzles)) {
          const own = Object.entries(sizes).find(([s]) => Number(s) === Number(n))?.[1]
          if (!(own && k in own.values) && !(k in nozzle.differs)) put(nozzle.differs, k, before)
        }
        put(entry.machine, k, v)
      }
    }
  }
}
