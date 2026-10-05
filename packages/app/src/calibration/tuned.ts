// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Calibration results are kept per filament, printer and nozzle. The key below names that triple; a preset
// carries it in `tuned`, so a second spool of the same type never overwrites the first.
import type { SettingValue } from '@slicerx/contracts'
import type { ResolvedSlot } from '../filament/slots'
import type { UserPreset } from '../presets/store'

type Slot = Pick<ResolvedSlot, 'type' | 'brand' | 'color'> & { family?: string }

/** A readable name for the spool: "Brand PLA", or "PLA" without a brand. */
export function filamentName(slot: Slot | undefined): string {
  return [slot?.brand, slot?.type].filter(Boolean).join(' ') || 'My filament'
}

/** The part of the key that names the filament: product, material and color. Colors differ in tuning, so a new color is a new spool. */
export function filamentKey(slot: Slot | undefined): string {
  return [slot?.family || slot?.brand || '', slot?.type ?? 'PLA', (slot?.color ?? '').toLowerCase()].join('|')
}

export const nozzleText = (mm: number): string => `${Number(mm.toFixed(2))} mm`

export function tuneKey(slot: Slot | undefined, printerId: string, nozzleMm: number): string {
  return `${filamentKey(slot)}@${printerId}@${nozzleMm}`
}

/** Preset name for a tuned filament, printer and nozzle. */
export function tunedPresetName(slot: Slot | undefined, nozzleMm: number, kind: UserPreset['kind']): string {
  const color = slot?.color ? ` ${slot.color.toLowerCase()}` : ''
  return `${filamentName(slot)}${color}, ${nozzleText(nozzleMm)} nozzle, tuned${kind === 'filament' ? '' : ` (${kind})`}`
}

export type TuneState =
  | { state: 'tuned'; results: { label: string; value: string }[] }
  | { state: 'retune'; fromNozzleMm: number }
  | { state: 'none' }

/** Whether the filament has results for this printer and nozzle, or only for another nozzle (retune). */
export function tuneState(presets: readonly UserPreset[], slot: Slot | undefined, printerId: string, nozzleMm: number): TuneState {
  const fk = filamentKey(slot)
  const mine = presets.filter((p) => p.tuned && p.tuned.key.startsWith(`${fk}@${printerId}@`))
  const here = mine.filter((p) => p.tuned!.nozzleMm === nozzleMm)
  if (here.length) {
    const results: { label: string; value: string }[] = []
    for (const p of here) for (const r of Object.values(p.tuned!.results)) results.push({ label: r.label, value: r.value })
    return { state: 'tuned', results }
  }
  const other = mine.find((p) => p.tuned!.nozzleMm !== nozzleMm)
  return other ? { state: 'retune', fromNozzleMm: other.tuned!.nozzleMm } : { state: 'none' }
}

/** The printer and nozzle a result is keyed to, from the state the slice reads. */
export function tuneContext(s: { profile: { printerId: string; nozzle: number } | null; printerId: string | null }): { printerId: string; nozzleMm: number } {
  return { printerId: s.profile?.printerId ?? s.printerId ?? 'printer', nozzleMm: s.profile?.nozzle ?? 0.4 }
}

/** The tuned filament values for one spool on this printer and nozzle, merged over every test that was run. Empty when it was never tuned here. */
export function tunedValues(presets: readonly UserPreset[], slot: Slot | undefined, printerId: string, nozzleMm: number): Record<string, SettingValue> {
  const key = tuneKey(slot, printerId, nozzleMm)
  const out: Record<string, SettingValue> = {}
  for (const p of presets) if (p.kind === 'filament' && p.tuned?.key === key) Object.assign(out, p.values)
  return out
}

/**
 * The clearance the hole tolerance test measured for this spool, printer and nozzle: the extra diameter at which
 * the peg fit. It is kept with the test result, on its own, so it survives a later change to the hole compensation
 * setting. Undefined when the test was never run here.
 */
export function measuredHoleClearance(presets: readonly UserPreset[], slot: Slot | undefined, printerId: string, nozzleMm: number): number | undefined {
  const key = tuneKey(slot, printerId, nozzleMm)
  let best: { at: number; mm: number } | undefined
  for (const p of presets) {
    const r = p.tuned?.key === key ? p.tuned.results['tolerance'] : undefined
    if (!r) continue
    const mm = r.raw ?? Number.parseFloat(r.value)
    if (Number.isFinite(mm) && mm > 0 && (!best || r.at > best.at)) best = { at: r.at, mm }
  }
  return best?.mm
}
