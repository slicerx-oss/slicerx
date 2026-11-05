// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Body colors from a CAD file (a STEP or IGES solid's color) as filaments: the plan comes from @slicerx/contracts/color-slots,
// against the slots as the filament rail shows them. This file says which slots count, how many the printer holds and
// what the open note says. React-free.
import { COLOR_SLOT_MAX, planColorSlots, type ColorSlot, type ColorSlotPlan } from '@slicerx/contracts'
import { colorName } from './rail'
import { resolveSlots, type ResolvedSlot } from './slots'
import type { AppState } from '../state/store'

type SlotInputs = Parameters<typeof resolveSlots>[0]

/** The most slots a plan may fill: the printer's slot count when it reports its slots, else the project's 16. */
export function bodyColorLimit(s: Pick<AppState, 'printerSlots'>): number {
  return s.printerSlots.length > 0 ? Math.min(COLOR_SLOT_MAX, s.printerSlots.length) : COLOR_SLOT_MAX
}

/**
 * The project's slots for a plan. A slot is free when it shows its default color and nothing prints with it; slot 1
 * is never free while any body has no color, since those bodies open on it.
 */
export function planSlots(slots: readonly Pick<ResolvedSlot, 'index' | 'color' | 'source' | 'used'>[], uncolored: boolean): ColorSlot[] {
  return slots.map((r) => ({ index: r.index, color: r.color, free: r.source === 'default' && !r.used && !(uncolored && r.index === 1) }))
}

/** The plan for one file's body colors (null where a body has none) on the project as it is now. */
export function planBodyColors(colors: readonly (string | null | undefined)[], s: SlotInputs & Pick<AppState, 'printerSlots'>): ColorSlotPlan {
  const uncolored = colors.some((c) => !c)
  return planColorSlots(colors, planSlots(resolveSlots(s), uncolored), { limit: bodyColorLimit(s) })
}

/** "filament 2 (Blue)", "filaments 2 (Blue) and 3 (Green)", "filaments 2 (Blue), 3 (Green) and 4 (Red)". */
function filamentList(add: ColorSlotPlan['add']): string {
  const each = add.map((a) => `${a.slot} (${colorName(a.color)})`)
  if (each.length === 1) return `filament ${each[0]}`
  return `filaments ${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}`
}

/** The open note's sentence for a plan; null when the file has no colors. */
export function bodyColorNote(plan: ColorSlotPlan, s: Pick<AppState, 'printerSlots'>): string | null {
  // one pick per distinct color: the plan hands every body of a color the same pick
  const distinct = [...new Set(plan.picks.filter((p) => p !== null))]
  if (!distinct.length) return null
  const over = distinct.filter((p) => p.match === 'nearest').length
  const out: string[] = []
  if (plan.add.length) out.push(`Added ${filamentList(plan.add)} for the file's colors.`)
  if (over) {
    const holds = s.printerSlots.length > 0 ? `the printer holds ${bodyColorLimit(s)}` : `a project holds ${COLOR_SLOT_MAX}`
    out.push(`The file has ${distinct.length} colors and ${holds}, so ${over} ${over === 1 ? 'prints' : 'print'} with the nearest filament's color.`)
  }
  if (!out.length) out.push(s.printerSlots.length > 0 ? "The file's colors matched loaded filaments." : "The file's colors matched the project's filaments.")
  return out.join(' ')
}
