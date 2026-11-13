// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A part's filament choice and settings are kept by its name (PlateEntry.slotOverrides, partSettings, the part picked
// for settings), so a part that is renamed takes them to its new name: a rename from the objects list, a tool's
// rename step (parts.name) as it lands, and either one undone.
import type { PlateEntry } from '../state/store'

/**
 * The parts renamed between two lists of the same parts, old name to new: at each place, a name that is in neither
 * list after it is gone and one that was in neither before. A new order (every name still there) renames nothing, and
 * lists of different lengths (parts added or taken away) are not compared.
 */
export function renamedParts(before: readonly string[], after: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (before.length !== after.length) return out
  const had = new Set(before)
  const has = new Set(after)
  before.forEach((name, i) => {
    const now = after[i]!
    if (now !== name && !has.has(name) && !had.has(now)) out.set(name, now)
  })
  return out
}

/** A record kept by part name, with each renamed part's entry under its new name; the record itself when none moves. */
export function renamedKeys<T>(record: Readonly<Record<string, T>> | undefined, renames: ReadonlyMap<string, string>): Record<string, T> | undefined {
  if (!record || !renames.size || !Object.keys(record).some((k) => renames.has(k))) return record
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [renames.get(k) ?? k, v]))
}

/** The object's filament choices and settings kept by part name, moved to the parts' new names. */
export function withRenamedParts<E extends Pick<PlateEntry, 'slotOverrides' | 'partSettings'>>(e: E, renames: ReadonlyMap<string, string>): E {
  const slotOverrides = renamedKeys(e.slotOverrides, renames)
  const partSettings = renamedKeys(e.partSettings, renames)
  if (slotOverrides === e.slotOverrides && partSettings === e.partSettings) return e
  return { ...e, ...(slotOverrides ? { slotOverrides } : {}), ...(partSettings ? { partSettings } : {}) }
}

/** The part picked for settings, under its new name when it was renamed. */
export function renamedScope(scope: { id: string; part: string } | null, objectId: string, renames: ReadonlyMap<string, string>): { id: string; part: string } | null {
  const to = scope?.id === objectId ? renames.get(scope.part) : undefined
  return to ? { id: objectId, part: to } : scope
}
