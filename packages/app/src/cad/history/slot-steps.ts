// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step that sets a part's filament (parts.slot) and the plate's own filament for that part (PlateEntry.slotOverrides):
// the most recent wins. The step clears the plate's filament for its part when it lands, so the step's slot shows; one
// the person picks afterward shows until they clear it or a later step sets the slot again. Undoing the step puts back
// what it cleared, so what showed before it shows again.
import type { History, Step } from '@slicerx/cad-history'
import type { PlateEntry } from '../../state/store'

/** What each parts.slot step cleared when it landed, by step id: the part's name and the filament it had. */
const cleared = new Map<string, Record<string, number>>()

const slotSteps = (h: History | undefined): Step[] => (h?.steps ?? []).filter((s) => s.params.op === 'parts.slot')

/**
 * The plate's own filaments of an object whose history goes from `before` to `after`: a parts.slot step that has just
 * come (a new step, or one put back by redo) clears the override of its part (every part for part -1), and one that
 * has just gone (undone) puts back what it cleared, unless the person picked another meanwhile. Steps in both keep
 * the overrides as they are. Null when nothing changes, so the write keeps the object's own; an empty record when
 * none are left.
 */
export function overridesAfterSlotSteps(latest: Pick<PlateEntry, 'slotOverrides'>, before: History | undefined, after: History, names: readonly string[]): Record<string, number> | null {
  const was = new Set((before?.steps ?? []).map((s) => s.id))
  const now = new Set(after.steps.map((s) => s.id))
  const gone = slotSteps(before).filter((s) => !now.has(s.id))
  const come = slotSteps(after).filter((s) => !was.has(s.id))
  if (!gone.length && !come.length) return null
  const next = { ...(latest.slotOverrides ?? {}) }
  for (const s of [...gone].reverse()) {
    for (const [name, slot] of Object.entries(cleared.get(s.id) ?? {})) if (next[name] === undefined) next[name] = slot
    cleared.delete(s.id)
  }
  for (const s of come) {
    const took: Record<string, number> = {}
    for (const name of s.part === -1 ? names : [(s.params as { name: string }).name]) {
      if (next[name] === undefined) continue
      took[name] = next[name]!
      delete next[name]
    }
    cleared.set(s.id, took)
  }
  return next
}

/** The object with these overrides (none when the record is empty), or as it is for null. */
export function withSlotOverrides<E extends Pick<PlateEntry, 'slotOverrides'>>(e: E, overrides: Record<string, number> | null): E {
  if (!overrides) return e
  const { slotOverrides: _old, ...rest } = e
  return (Object.keys(overrides).length ? { ...rest, slotOverrides: overrides } : rest) as E
}
