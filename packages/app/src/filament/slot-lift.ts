// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A filament's own travel slope (`filament_travel_slope`), one entry per filament slot, read the way the engine reads it:
// slot N takes entry N - 1, a missing entry falls back to the last one, and "", "nil", null or an empty list means the
// filament uses the printer's value. The Filament dialog and the tests share these, so the dialog never disagrees with
// the slice.
import type { SettingValue } from '@slicerx/contracts'
import { markStale, set } from '../state/store'

export const SLOPE_KEY = 'filament_travel_slope'
export const SLOPE_MIN = 0
export const SLOPE_MAX = 90

type Values = Readonly<Record<string, SettingValue | undefined>>

function unset(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === '' || v.trim() === 'nil'
  return Array.isArray(v) && v.length === 0
}

function asNumber(v: unknown): number | undefined {
  if (unset(v)) return undefined
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Slot `slot`'s own entry of a per-filament list (1-based), with the engine's last-entry fallback. */
export function slotEntry(list: SettingValue | undefined, slot: number): unknown {
  if (!Array.isArray(list)) return list
  if (list.length === 0) return undefined
  return list[Math.max(1, slot) - 1] ?? list[list.length - 1]
}

/** Slot `slot`'s own travel slope in degrees, or undefined when it uses the printer's. */
export function slotSlope(values: Values, slot: number): number | undefined {
  return asNumber(slotEntry(values[SLOPE_KEY], slot))
}

/**
 * The overrides with slot `slot`'s travel slope set to `value`, or cleared to "nil" when `value` is undefined. The list
 * is first spelled out for every slot up to `slotCount` with the same fallback, so a one-entry list from an import keeps
 * meaning the same for the other slots. When no slot is left with a value (here or in `inherited`, the value under the
 * overrides) the key is dropped.
 */
export function withSlotSlope(overrides: Values, slot: number, slotCount: number, value: number | undefined, inherited?: SettingValue): Record<string, SettingValue> {
  const cur = overrides[SLOPE_KEY] ?? inherited
  const n = Math.max(1, slot, slotCount, Array.isArray(cur) ? cur.length : 0)
  const list = Array.from({ length: n }, (_, i) => {
    const e = slotEntry(cur, i + 1)
    return (unset(e) ? 'nil' : e) as string | number
  })
  list[slot - 1] = value === undefined ? 'nil' : value
  const next = { ...overrides } as Record<string, SettingValue>
  if (list.every(unset) && slotSlopeList(inherited).every(unset)) delete next[SLOPE_KEY]
  else next[SLOPE_KEY] = list as SettingValue
  return next
}

function slotSlopeList(v: SettingValue | undefined): unknown[] {
  return Array.isArray(v) ? v : v === undefined ? [] : [v]
}

/**
 * What the slope field's text commits: a number clamped to 0 to 90, undefined for an empty field (the printer's value),
 * or null for text that is not a number (the field goes back to what it held).
 */
export function parseSlope(text: string): number | undefined | null {
  const t = text.trim()
  if (t === '') return undefined
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return Math.min(SLOPE_MAX, Math.max(SLOPE_MIN, n))
}

/** Sets slot `slot`'s travel slope in the plate overrides (undefined clears it) and marks the slice stale. */
export function setSlotSlope(slot: number, slotCount: number, value: number | undefined, inherited?: SettingValue): void {
  set((s) => ({ overrides: withSlotSlope(s.overrides, slot, slotCount, value, inherited) }))
  markStale()
}

/** The lift slot `slot` makes, from its own values or the printer's: the height in mm and the type's value. */
export function slotLift(config: Values, slot: number): { height: number; type: string } {
  const own = (key: string) => {
    const e = slotEntry(config[`filament_${key}`], slot)
    return unset(e) ? undefined : e
  }
  const first = (v: SettingValue | undefined) => (Array.isArray(v) ? v[0] : v)
  const height = asNumber(own('z_hop')) ?? asNumber(first(config['z_hop'])) ?? 0
  const type = String(own('z_hop_types') ?? first(config['z_hop_types']) ?? 'Slope Lift')
  return { height, type }
}

/** The printer's own travel slope in degrees: entry 0 of `travel_slope`, else 3 as the engine takes it. */
export function printerSlope(config: Values): number {
  const v = config['travel_slope']
  return asNumber(Array.isArray(v) ? v[0] : v) ?? 3
}

/**
 * The lines under the slope field: what the filament climbs at, and when the slope has no effect. One or two short
 * sentences. Auto lifts slope or spiral, so they use the angle too; only a Normal lift climbs straight up.
 */
export function slopeHint(config: Values, slot: number): string {
  const own = slotSlope(config, slot)
  const fmt = (n: number) => `${Number(n.toFixed(2))}°`
  const lines = [
    own === undefined
      ? `Uses the printer's travel slope, ${fmt(printerSlope(config))}.`
      : own === 0
        ? 'At 0°, a ramp lift climbs straight up and a slope or spiral lift uses 3°.'
        : `Climbs at ${fmt(own)} for this filament.`,
  ]
  const lift = slotLift(config, slot)
  if (lift.height <= 0) lines.push('Z hop height is 0, so there is no lift.')
  else if (lift.type === 'Normal Lift') lines.push('The lift type is Normal, so the slope is not used.')
  return lines.join(' ')
}
