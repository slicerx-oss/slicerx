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
  // Second anchors for names whose common filament colors sit far from the first one: bright and amber oranges, gold,
  // olive, pale and bright yellows, hot and light pinks, a redder brown, and the plain web teal and navy.
  ['Orange', '#ff8000'],
  ['Orange', '#ffa500'],
  ['Gold', '#d4af37'],
  ['Gold', '#ffd700'],
  ['Olive', '#808000'],
  ['Pink', '#ff69b4'],
  ['Pink', '#ffc0cb'],
  ['Brown', '#8b4513'],
  ['Yellow', '#ffff00'],
  ['Yellow', '#fff59d'],
  ['Teal', '#008080'],
  ['Navy', '#000080'],
]

/** A #rrggbb color in CIELAB (D65), where distance follows how far apart people see two colors. Null when unreadable. */
function lab(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})/i.exec(hex)
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  const lin = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)]
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047)
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b)
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/**
 * The nearest plain color name, for labels such as "1 PLA Black". Nearest as people see it (CIELAB): a bright green
 * such as #50fa7b is as far from Gray as from Green in plain RGB, and RGB picked Gray.
 */
export function colorName(hex: string): string {
  const c = lab(hex)
  if (!c) return NAMES[0]![0]
  let best = NAMES[0]!
  let d = Number.POSITIVE_INFINITY
  for (const n of NAMES) {
    const w = lab(n[1])!
    const e = Math.hypot(c[0] - w[0], c[1] - w[1], c[2] - w[2])
    if (e < d) [best, d] = [n, e]
  }
  return best[0]
}

/** A slot as a picker lists it: "1 PLA Black", or "A2 PETG White" on an AMS. */
export function slotLabel(s: Pick<ResolvedSlot, 'label' | 'type' | 'color'>): string {
  return `${s.label} ${s.type} ${colorName(s.color)}`
}

/**
 * The slots the sidebar strip shows: every project filament in order, the ones nothing prints with dimmed. When the
 * printer reports slots, the strip stops at the printer's slot count (its external spool is one of those slots).
 */
export function stripSlots(slots: readonly ResolvedSlot[], printerSlotCount: number): ResolvedSlot[] {
  return printerSlotCount > 0 ? slots.filter((s) => s.index <= printerSlotCount) : [...slots]
}

/**
 * What a part's filament badge says: the slot id in full ("10" is two digits, never cut to "0"), or "?" when the slot is
 * not 1 or more or is not one of the strip's filaments.
 */
export function partBadge(slot: number | null | undefined, strip: readonly Pick<ResolvedSlot, 'index'>[]): { text: string; known: boolean } {
  const known = typeof slot === 'number' && Number.isInteger(slot) && slot >= 1 && strip.some((s) => s.index === slot)
  return { text: known ? String(slot) : '?', known }
}
