// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A maker overlay: newer values from the maker's own app for settings the engine reads, written over the generated preset
// data as its last step. packages/profiles/overlays/bbl-2.8.json holds Bambu Studio 2.8's values for the Bambu Lab
// presets: filament presets by name (filaments/BBL.json), and the printer, default filament and process tiers of each
// model and nozzle (resolved/bambu-lab.json). scripts/gen-resolved.ts applies it before writing, and
// scripts/apply-overlay.ts applies it to the shipped files, so a regeneration of either file keeps it. Applying it twice
// changes nothing.
import { sameValue } from './diff'
import { importFlat } from './import'
import { defaultConfig } from './schema'
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
}

interface TierDiff { set: Raw; unset: string[] }
interface Part { base: string; machine: Raw; filament: Raw; process: Record<string, Raw | TierDiff> }
interface Entry extends Part { nozzles?: Record<string, Part> }
export interface ResolvedBrand { models: Record<string, Entry> }
export interface VendorData { families: Record<string, { base: Raw; variants: Record<string, Raw | undefined> }> }

/** The Bambu Lab overlay, relative to packages/profiles. */
export const BBL_OVERLAY = 'overlays/bbl-2.8.json'

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

/** Applies the overlay's printer, default filament and process values to a brand's resolved file, in place. */
export function applyResolvedOverlay(data: ResolvedBrand, overlay: MakerOverlay, defaultNozzle: (model: string) => number): void {
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
