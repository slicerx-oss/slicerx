// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Print settings card edits: the plate, the selected objects, or one part. A field reads its value through
// the scope (own, inherited from the plate, or mixed across a selection) and writes through it to the object and part
// overrides in plate/object-settings.ts.
import type { SettingValue } from '@slicerx/contracts'
import type { AppState, PlateEntry } from '../state/store'
import { objectOverrides, partOverridesOf, setObjectSetting, setPartSetting, sourceId } from './object-settings'

export type SettingsScope = { kind: 'plate' } | { kind: 'objects'; ids: string[] } | { kind: 'part'; id: string; part: string }

/** The scope a selection gives: none is the plate, a part picked in the tree is that part. */
export function scopeOf(selected: readonly string[], part?: { id: string; part: string } | null): SettingsScope {
  if (part && selected.length === 1 && selected[0] === part.id) return { kind: 'part', id: part.id, part: part.part }
  return selected.length ? { kind: 'objects', ids: [...selected] } : { kind: 'plate' }
}

export interface ScopedValue {
  value: SettingValue | undefined
  /** own: set on every target alike; plate: none set; mixed: the targets differ. */
  source: 'own' | 'plate' | 'mixed'
  plateValue: SettingValue | undefined
}

const same = (a: SettingValue | undefined, b: SettingValue | undefined) => JSON.stringify(a) === JSON.stringify(b)

/** A setting's value in a scope. `plate` is the plate's resolved configuration. */
export function scopeValue(s: Pick<AppState, 'plate' | 'objectSettings'>, plate: Readonly<Record<string, SettingValue>>, key: string, scope: SettingsScope): ScopedValue {
  const plateValue = plate[key]
  if (scope.kind === 'plate') return { value: plateValue, source: 'plate', plateValue }
  if (scope.kind === 'part') {
    const entry = s.plate.find((p) => p.id === scope.id)
    const own = entry ? partOverridesOf(s.plate, entry)[scope.part]?.[key] : undefined
    if (own !== undefined) return { value: own, source: 'own', plateValue }
    // A part without its own value prints with its object's.
    const obj = entry ? objectOverrides(s, entry)[key] : undefined
    return { value: obj ?? plateValue, source: obj !== undefined ? 'own' : 'plate', plateValue }
  }
  const values = targets(s.plate, scope.ids).map((p) => objectOverrides(s, p)[key])
  const first = values[0]
  if (!values.every((v) => same(v, first))) return { value: undefined, source: 'mixed', plateValue }
  return first === undefined ? { value: plateValue, source: 'plate', plateValue } : { value: first, source: 'own', plateValue }
}

/** Instances share their source's settings, so a selection writes once per source. */
function targets(plate: readonly PlateEntry[], ids: readonly string[]): PlateEntry[] {
  const seen = new Set<string>()
  const out: PlateEntry[] = []
  for (const p of plate) {
    if (!ids.includes(p.id) || seen.has(sourceId(p))) continue
    seen.add(sourceId(p))
    out.push(p)
  }
  return out
}

/** Sets or, with undefined, resets a setting in a scope. The plate scope is the caller's: it writes the print settings. */
export function setScoped(s: Pick<AppState, 'plate'>, scope: SettingsScope, key: string, value: SettingValue | undefined): void {
  if (scope.kind === 'part') setPartSetting(scope.id, scope.part, key, value)
  else if (scope.kind === 'objects') for (const p of targets(s.plate, scope.ids)) setObjectSetting(p.id, key, value)
}

/** How many settings an object has of its own, its parts' included: the badge on its row. */
export function overrideCount(s: Pick<AppState, 'plate' | 'objectSettings'>, p: PlateEntry): number {
  const parts = Object.values(partOverridesOf(s.plate, p)).reduce((n, o) => n + Object.keys(o).length, 0)
  return Object.keys(objectOverrides(s, p)).length + parts
}
