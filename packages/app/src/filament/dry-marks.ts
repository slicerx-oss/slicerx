// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "It's dry" on the drying note. The answer is kept per printer and slot with the spool it was given
// for, so the note comes back when that slot gets another spool (a new RFID tag or a changed tray
// from the printer) or after seven days, when the spool may have taken up moisture again.
import type { FilamentSlot } from '@slicerx/contracts'

export interface DryMark { at: number; spool: string }

/** How long "It's dry" holds. */
export const DRY_FOR_MS = 7 * 24 * 3600 * 1000

/** The drying note and the drying question the settings plan writes (packages/settings/js/plan.ts). */
export function isDryingNote(text: string): boolean {
  return /^Dry .+ before printing\b/.test(text) || /been dried in the last day\?/.test(text)
}

export function dryKey(printerId: string | null, slot: string): string {
  return `${printerId ?? 'none'}|${slot}`
}

/** What tells one spool in a slot from the next: the printer's spool tag, else what is loaded. */
export function spoolOf(slot: { type: string; color: string; brand?: string }, printer?: Pick<FilamentSlot, 'spoolUid' | 'material' | 'color'>): string {
  if (printer?.spoolUid) return `tag:${printer.spoolUid}`
  if (printer?.material) return `tray:${printer.material}|${printer.color ?? ''}`.toLowerCase()
  return `set:${slot.type}|${slot.brand ?? ''}|${slot.color}`.toLowerCase()
}

/** True while "It's dry" still holds for this spool. */
export function stillDry(mark: DryMark | undefined, spool: string, now: number): boolean {
  return mark !== undefined && mark.spool === spool && now - mark.at >= 0 && now - mark.at < DRY_FOR_MS
}

/** The marks without the ones that no longer hold, so the stored list does not grow. */
export function pruneMarks(marks: Readonly<Record<string, DryMark>>, now: number): Record<string, DryMark> {
  return Object.fromEntries(Object.entries(marks).filter(([, m]) => now - m.at < DRY_FOR_MS))
}
