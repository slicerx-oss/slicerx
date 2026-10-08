// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The filament rail's data: grams per slot from the last slice, slots where the printer holds something else than the
// project asks for, the units the rail groups slots by, and plain color names for slot labels.
import type { FilamentSlot, SliceStats } from '@slicerx/contracts'
import { colorDistance } from '../send/options'
import { materialType, type ResolvedSlot } from './slots'

/** Grams and share of the plate's filament for each slot, index 0 is slot 1. Empty before a slice. */
export function slotUsage(stats: Pick<SliceStats, 'filamentG'> | null | undefined, count: number): { grams: number; share: number }[] {
  if (!stats) return []
  const total = stats.filamentG.reduce((a, b) => a + b, 0)
  return Array.from({ length: count }, (_, i) => {
    const grams = stats.filamentG[i] ?? 0
    return { grams, share: total > 0 ? grams / total : 0 }
  })
}

/** Colors this far apart or more (0 to 441) read as a different spool; the send dialog's backup check uses the same. */
const NEAR = 60

export interface SlotMismatch {
  slot: number
  type: string
  color: string
  printerType: string
  printerColor: string
}

/**
 * Slots set by hand to a filament the printer does not hold there. A slot the printer reports nothing for, or one
 * that follows the printer, is never a mismatch.
 */
export function slotMismatch(printerSlots: readonly FilamentSlot[], slots: readonly ResolvedSlot[]): SlotMismatch[] {
  const out: SlotMismatch[] = []
  for (const s of slots) {
    const p = printerSlots[s.index - 1]
    if (s.source !== 'user' || !p || (!p.material && !p.color)) continue
    const printerType = materialType(p.material)
    const printerColor = p.color ? `#${p.color.replace('#', '').slice(0, 6)}` : s.color
    if (printerType !== s.type || colorDistance(printerColor, s.color) >= NEAR) out.push({ slot: s.index, type: s.type, color: s.color, printerType, printerColor })
  }
  return out
}

/** Slots grouped by the unit that holds them: AMS 1, AMS 2, then External; one group when there is only one unit. */
export function railGroups(slots: readonly ResolvedSlot[]): { unit: string; slots: ResolvedSlot[] }[] {
  const groups = new Map<string, ResolvedSlot[]>()
  for (const s of slots) {
    const unit = /^[A-Z]\d$/.test(s.label) ? `AMS ${s.label.charCodeAt(0) - 64}` : /^ext/i.test(s.label) ? 'External' : 'Slots'
    groups.set(unit, [...(groups.get(unit) ?? []), s])
  }
  return [...groups].map(([unit, list]) => ({ unit, slots: list }))
}

const NAMES: readonly [string, string][] = [
  ['Black', '#000000'],
  ['White', '#ffffff'],
  ['Gray', '#8e8e93'],
  ['Silver', '#c0c0c0'],
  ['Red', '#d32f2f'],
  ['Orange', '#f57c00'],
  ['Yellow', '#fbc02d'],
  ['Green', '#388e3c'],
  ['Teal', '#00897b'],
  ['Cyan', '#00acc1'],
  ['Blue', '#1e66f5'],
  ['Navy', '#1a237e'],
  ['Purple', '#7b1fa2'],
  ['Pink', '#e91e63'],
  ['Brown', '#6d4c41'],
  ['Beige', '#e6d3b3'],
]

/** The nearest plain color name, for labels such as "1 PLA Black". */
export function colorName(hex: string): string {
  let best = NAMES[0]!
  let d = Number.POSITIVE_INFINITY
  for (const n of NAMES) {
    const e = colorDistance(hex, n[1])
    if (e < d) [best, d] = [n, e]
  }
  return best[0]
}

/** A slot as a picker lists it: "1 PLA Black", or "A2 PETG White" on an AMS. */
export function slotLabel(s: Pick<ResolvedSlot, 'label' | 'type' | 'color'>): string {
  return `${s.label} ${s.type} ${colorName(s.color)}`
}
