// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which filament prints each feature (walls, infill, surfaces, support): one table in the Color tab, read and written
// through the Print settings scope (plate/scope.ts), so the same table sets the plate or the selected objects. 0 is
// the object's own filament; 1 and up is that filament slot. After a slice that is still current, each row also says
// which filaments the feature printed with (the slice's featureFilaments).
import type { FeatureFilaments, SettingValue } from '@slicerx/contracts'
import type { AppState } from '../state/store'
import { FEATURE_FILAMENT_KEYS, FEATURE_FILAMENT_ROWS, type FeatureFilamentDef } from './feature-filament-keys'
import { partOverridesOf, objectOverrides } from './object-settings'
import { scopeValue, setPlateOverrides, setScopedMany, targets, type SettingsScope } from './scope'

export { FEATURE_FILAMENT_KEYS, FEATURE_FILAMENT_ROWS, type FeatureFilamentDef } from './feature-filament-keys'

/** What the default value means. */
export const OBJECTS_FILAMENT = "Object's filament"

export interface FeatureFilamentRow extends FeatureFilamentDef {
  /** 0 for the object's filament, else the slot; undefined when the selection is mixed. */
  value: number | undefined
  /** plate: the scope inherits the plate's value; own: the scope's targets set it; mixed: they differ. */
  source: 'plate' | 'own' | 'mixed'
  /** The plate's value, which a selection without its own inherits. */
  plateValue: number
  /** The scope holds a value of its own for this row: a plate edit, or the selection's own value. */
  changed: boolean
  /** The slots the feature printed with in the current slice, ascending; null with no current slice. */
  printedWith: number[] | null
}

/** A stored value as a slot number, 0 when unset or unreadable. */
export function slotOf(v: SettingValue | undefined): number {
  const n = Number(Array.isArray(v) ? v[0] : v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** The slice's per-object feature filaments, when the slice on screen is finished and still matches the plate. */
export function currentFeatureFilaments(s: Pick<AppState, 'slice'>): readonly FeatureFilaments[] | null {
  return s.slice.status === 'done' && !s.slice.stale ? (s.slice.result.featureFilaments ?? null) : null
}

/** The objects a scope covers in the slice report: every one for the plate. */
function inScope(report: readonly FeatureFilaments[], scope: SettingsScope): readonly FeatureFilaments[] {
  if (scope.kind === 'plate') return report
  const ids = scope.kind === 'part' ? [scope.id] : scope.ids
  return report.filter((r) => ids.includes(r.object))
}

/** The slots one feature printed with across the scope's objects, ascending. */
export function printedWith(report: readonly FeatureFilaments[], scope: SettingsScope, feature: string): number[] {
  const slots = new Set<number>()
  for (const r of inScope(report, scope)) for (const n of r.features[feature] ?? []) slots.add(n)
  return [...slots].sort((a, b) => a - b)
}

/** Every row of the table for a scope. `config` is the plate's resolved configuration. */
export function featureFilamentRows(s: Pick<AppState, 'plate' | 'objectSettings' | 'overrides' | 'slice'>, config: Readonly<Record<string, SettingValue>>, scope: SettingsScope): FeatureFilamentRow[] {
  // The report is per object, so a part has no printed-with of its own to show.
  const report = scope.kind === 'part' ? null : currentFeatureFilaments(s)
  const part = scope.kind === 'part' ? s.plate.find((p) => p.id === scope.id) : undefined
  const partOwn = part && scope.kind === 'part' ? (partOverridesOf(s.plate, part)[scope.part] ?? {}) : {}
  const sources = scope.kind === 'objects' ? targets(s.plate, scope.ids) : []
  return FEATURE_FILAMENT_ROWS.map((def) => {
    const sv = scopeValue(s, config, def.key, scope)
    const plateValue = slotOf(sv.plateValue)
    let value = sv.source === 'mixed' ? undefined : slotOf(sv.value)
    let source = sv.source
    let changed = scope.kind === 'plate' ? def.key in s.overrides : sv.source === 'own'
    // A part inherits its object's value: only a value the part holds itself is its own.
    if (scope.kind === 'part') changed = def.key in partOwn
    // Objects differ only when the slots they print with differ: an object set to 0 and one left at the plate's 0
    // print alike, and so do 2 and "2" from a project file.
    if (sv.source === 'mixed') {
      const own = sources.map((p) => objectOverrides(s, p)[def.key])
      const slots = new Set(own.map((v) => (v === undefined ? plateValue : slotOf(v))))
      if (slots.size === 1) {
        value = [...slots][0]!
        source = own.every((v) => v !== undefined) ? 'own' : 'plate'
        changed = source === 'own'
      }
    }
    return { ...def, value, source, plateValue, changed, printedWith: report ? printedWith(report, scope, def.feature) : null }
  })
}

/** The table as a client reads it back (the agent bridge and the app link): the scope and every row, null when mixed. */
export function featureFilamentReadback(s: Pick<AppState, 'plate' | 'objectSettings' | 'overrides' | 'slice'>, config: Readonly<Record<string, SettingValue>>, scope: SettingsScope) {
  return {
    scope: scope.kind === 'plate' ? { kind: 'plate' as const } : scope.kind === 'part' ? { kind: 'part' as const, object: scope.id, part: scope.part } : { kind: 'objects' as const, objects: scope.ids },
    rows: featureFilamentRows(s, config, scope).map((r) => ({ feature: r.feature, label: r.label, key: r.key, value: r.value ?? null, source: r.source, changed: r.changed, printedWith: r.printedWith })),
  }
}

/**
 * Sets a row's filament in a scope, or with undefined clears it: the plate's edit goes back to the Easy value, an
 * object's own goes back to the plate's.
 */
export function setFeatureFilament(s: Pick<AppState, 'plate'>, scope: SettingsScope, key: string, value: number | undefined): void {
  setFeatureFilaments(s, scope, [[key, value]])
}

/** Several rows at once, as setFeatureFilament sets one: for objects, one undo step. */
export function setFeatureFilaments(s: Pick<AppState, 'plate'>, scope: SettingsScope, entries: readonly (readonly [string, number | undefined])[]): void {
  for (const [key] of entries) if (!FEATURE_FILAMENT_KEYS.has(key)) throw new Error(`${key} is not a feature filament setting`)
  if (scope.kind === 'plate') setPlateOverrides(entries)
  else setScopedMany(s, scope, entries)
}
