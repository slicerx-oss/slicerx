// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Per-object setting overrides, by the object's source id so instances share them (as in Bambu
// Studio and OrcaSlicer). Objects on a plate may carry different settings; layer height may differ
// only when the plate prints by object, and layerHeightConflict says when it does not.
import type { SettingValue } from '@slicerx/contracts'
import { get, markStale, set, type AppState, type PlateEntry } from '../state/store'

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
 * The engine lets objects on a plate carry different settings, but layer height may differ only when the
 * plate prints by object. Returns the sentence to show when it does not, or null.
 */
export function layerHeightConflict(s: Pick<AppState, 'plate' | 'objectSettings'>, sequence: 'by-layer' | 'by-object', plateLayerHeight: number): string | null {
  if (sequence === 'by-object') return null
  const heights = new Map<number, string[]>()
  for (const p of s.plate) {
    const v = objectOverrides(s, p)['layer_height']
    const h = typeof v === 'number' ? v : plateLayerHeight
    heights.set(h, [...(heights.get(h) ?? []), p.name])
  }
  if (heights.size < 2) return null
  const list = [...heights].map(([h, names]) => `${h} mm for ${names.slice(0, 2).join(', ')}${names.length > 2 ? ' and more' : ''}`).join('; ')
  return `Objects on this plate have different layer heights (${list}). Layer height can differ between objects only when the plate prints by object. Set the print sequence to By object, give the objects the same layer height, or move them to separate plates.`
}
