// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Per-object setting overrides, by the object's source id so instances share them (as in Bambu
// Studio and OrcaSlicer). Objects on a plate may carry different settings; layer height may differ
// too, except where a prime tower prints layer by layer, and layerHeightConflict says when it does.
import type { SettingValue, SliceWarning } from '@slicerx/contracts'
import { get, markStale, set, type AppState, type PlateEntry, type PlateMeta } from '../state/store'
import { effectiveSlot, mapSlot } from '../filament/slots'
import { plateSequence } from './plate-sequence'
import { smoothTimelapseTower } from '@slicerx/settings/arrange-room'

export const sourceId = (p: Pick<PlateEntry, 'id' | 'instanceOf'>) => p.instanceOf ?? p.id

export function objectOverrides(s: Pick<AppState, 'objectSettings'>, p: Pick<PlateEntry, 'id' | 'instanceOf'>): Record<string, SettingValue> {
  return s.objectSettings[sourceId(p)] ?? {}
}

export function setObjectSetting(objectId: string, key: string, value: SettingValue | undefined): void {
  const s = get()
  const entry = s.plate.find((p) => p.id === objectId)
  if (!entry) return
  const id = sourceId(entry)
  const cur = { ...(s.objectSettings[id] ?? {}) }
  if (value === undefined) delete cur[key]
  else cur[key] = value
  const next = { ...s.objectSettings }
  if (Object.keys(cur).length) next[id] = cur
  else delete next[id]
  set({ objectSettings: next })
  markStale()
}

/** The part overrides of an object; an instance reads its source's. */
export function partOverridesOf(plate: readonly PlateEntry[], p: Pick<PlateEntry, 'id' | 'instanceOf' | 'partSettings'>): Record<string, Record<string, SettingValue>> {
  const src = p.instanceOf ? plate.find((e) => e.id === p.instanceOf) : undefined
  return (src ?? p).partSettings ?? {}
}

export function setPartSetting(objectId: string, part: string, key: string, value: SettingValue | undefined): void {
  const s = get()
  const entry = s.plate.find((p) => p.id === objectId)
  if (!entry) return
  const all = { ...(entry.partSettings ?? {}) }
  const cur = { ...(all[part] ?? {}) }
  if (value === undefined) delete cur[key]
  else cur[key] = value
  if (Object.keys(cur).length) all[part] = cur
  else delete all[part]
  const { partSettings: _old, ...rest } = entry
  set({ plate: s.plate.map((p) => (p.id === objectId ? ({ ...rest, ...(Object.keys(all).length ? { partSettings: all } : {}) } as PlateEntry) : p)) })
  markStale()
}

/**
 * layerHeightConflict for plate `meta` with its print sequence, layer height and prime tower from `config`, the plate's
 * settings as the slice resolves them (the person's changes and an opened project's settings included). The tower prints
 * when it is on and the plate's objects print more than one filament, or with a smooth timelapse on a Bambu Lab printer.
 */
export function plateLayerHeightConflict(s: Pick<AppState, 'plate' | 'objectSettings'>, meta: PlateMeta | undefined, config: Readonly<Record<string, unknown>>): string | null {
  const layer = Array.isArray(config['layer_height']) ? config['layer_height'][0] : config['layer_height']
  const sizes = (Array.isArray(config['nozzle_diameter']) ? config['nozzle_diameter'] : [config['nozzle_diameter']]).map(Number).filter((d) => d > 0)
  const mixed = sizes.some((d) => Math.abs(d - sizes[0]!) >= 1e-3)
  return layerHeightConflict(s, plateSequence(meta, config), typeof layer === 'number' ? layer : 0.2, towerPrints(s, meta, config), mixed)
}

/**
 * Whether plate `meta` prints a prime tower with `config`: the tower is on and the plate's objects print more than one
 * filament, or a smooth timelapse on a Bambu Lab printer prints it with one.
 */
export function towerPrints(s: Pick<AppState, 'plate'>, meta: PlateMeta | undefined, config: Readonly<Record<string, unknown>>): boolean {
  const slots = new Set<number>()
  for (const p of s.plate) if (p.printable !== false) for (const part of p.parts) slots.add(mapSlot(meta, effectiveSlot(p, part)))
  return switchOn(config['enable_prime_tower']) && (slots.size > 1 || smoothTimelapseTower(config))
}

/** Clears every object's own layer height, so the plate prints at one layer height (the fix a prime tower asks for). */
export function useOneLayerHeight(): void {
  for (const p of get().plate) if (objectOverrides(get(), p)['layer_height'] !== undefined) setObjectSetting(p.id, 'layer_height', undefined)
}

/** A switch setting's value as on or off: engine values come as booleans, numbers or strings. */
function switchOn(v: unknown): boolean {
  const x = Array.isArray(v) ? v[0] : v
  return x === true || x === 1 || x === '1' || x === 'true'
}

/**
 * The engine prints objects of different layer heights on one plate, each at its own height, but a prime tower
 * (`tower`: it prints) needs one layer height for every object when the plate prints layer by layer. Returns the
 * sentence to show when it does not have one, or null. With nozzles of different sizes (`mixedSizes`) it says that
 * only the layer height is shared.
 */
export function layerHeightConflict(s: Pick<AppState, 'plate' | 'objectSettings'>, sequence: 'by-layer' | 'by-object', plateLayerHeight: number, tower = false, mixedSizes = false): string | null {
  if (sequence === 'by-object' || !tower) return null
  const heights = new Map<number, string[]>()
  for (const p of s.plate) {
    const v = objectOverrides(s, p)['layer_height']
    const h = typeof v === 'number' ? v : plateLayerHeight
    heights.set(h, [...(heights.get(h) ?? []), p.name])
  }
  if (heights.size < 2) return null
  const list = [...heights].map(([h, names]) => `${h} mm for ${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and more' : ''}`).join('; ')
  return `A prime tower makes every object print at one shared layer height, and objects on this plate have their own (${list}).${mixedSizes ? ' Each nozzle keeps its own line widths.' : ''} Use one layer height, turn the prime tower off, or set the print sequence to By object.`
}

/** A layer height a setting holds: a number, or the text of one. */
function heightOf(v: SettingValue | undefined): number | null {
  const h = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(h) ? h : null
}

/**
 * The warning for smart layer heights over layer heights objects set for themselves, or null when none does. The app's
 * layer plan is one for the whole plate, as the engine's own is, so an object's own layer height is not used. A part
 * never prints at a layer height of its own inside its object, so only objects are named. The wording matches the
 * engine's, which warns when it plans the layers itself. `lead` names what replaces them: a plate's own layer heights
 * say so in the same words.
 */
export function smartLayerWarning(s: Pick<AppState, 'plate' | 'objectSettings'>, lead = 'Smart layer heights'): SliceWarning | null {
  const own: string[] = []
  for (const p of s.plate.filter((e) => e.printable !== false)) {
    const h = heightOf(objectOverrides(s, p)['layer_height'])
    if (h !== null) own.push(`${p.name} ${h} mm`)
  }
  const named = [...new Set(own)]
  return named.length ? { code: 'unsupported_setting', message: `${lead} replace the layer heights objects set for themselves (${named.join(', ')}).` } : null
}
