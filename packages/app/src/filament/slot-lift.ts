// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A filament's own lift: its Z hop height (`filament_z_hop`), Z hop type (`filament_z_hop_types`) and travel slope
// (`filament_travel_slope`), one entry per filament slot, read the way the engine reads them: slot N takes entry N - 1, a missing entry falls back to the last one, and "", "nil", null or an empty list means the
// filament uses the printer's value. The Filament dialog and the tests share these, so the dialog never disagrees with
// the slice.
import type { SettingValue } from '@slicerx/contracts'
import { markStale, set } from '../state/store'

export const SLOPE_KEY = 'filament_travel_slope'
export const SLOPE_MIN = 0
export const SLOPE_MAX = 90
export const HEIGHT_KEY = 'filament_z_hop'
export const HEIGHT_MIN = 0
export const HEIGHT_MAX = 5
export const TYPE_KEY = 'filament_z_hop_types'
/** The lift types by value, with the names the app shows. */
export const LIFT_TYPES: readonly { value: string; label: string }[] = [
  { value: 'Auto Lift', label: 'Auto' },
  { value: 'Normal Lift', label: 'Normal' },
  { value: 'Slope Lift', label: 'Slope' },
  { value: 'Spiral Lift', label: 'Spiral' },
  { value: 'Ramp Lift', label: 'Ramp' },
]

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
 * The overrides with slot `slot`'s entry of the per-filament list `key` set to `value`, or cleared to "nil" when `value`
 * is undefined. The list is first spelled out for every slot up to `slotCount` with the same fallback, so a one-entry
 * list from an import keeps meaning the same for the other slots. When no slot is left with a value (here or in
 * `inherited`, the value under the overrides) the key is dropped.
 */
export function withSlotValue(key: string, overrides: Values, slot: number, slotCount: number, value: number | string | undefined, inherited?: SettingValue): Record<string, SettingValue> {
  const cur = overrides[key] ?? inherited
  const n = Math.max(1, slot, slotCount, Array.isArray(cur) ? cur.length : 0)
  const list = Array.from({ length: n }, (_, i) => {
    const e = slotEntry(cur, i + 1)
    return (unset(e) ? 'nil' : e) as string | number
  })
  list[slot - 1] = value === undefined ? 'nil' : value
  const next = { ...overrides } as Record<string, SettingValue>
  if (list.every(unset) && listOf(inherited).every(unset)) delete next[key]
  else next[key] = list as SettingValue
  return next
}

/** The overrides with slot `slot`'s travel slope set to `value` (see withSlotValue). */
export function withSlotSlope(overrides: Values, slot: number, slotCount: number, value: number | undefined, inherited?: SettingValue): Record<string, SettingValue> {
  return withSlotValue(SLOPE_KEY, overrides, slot, slotCount, value, inherited)
}

function listOf(v: SettingValue | undefined): unknown[] {
  return Array.isArray(v) ? v : v === undefined ? [] : [v]
}

/**
 * What the slope field's text commits: a number clamped to 0 to 90, undefined for an empty field (the printer's value),
 * or null for text that is not a number (the field goes back to what it held).
 */
export function parseSlope(text: string): number | undefined | null {
  return parseClamped(text, SLOPE_MIN, SLOPE_MAX)
}

/** What the Z hop height field's text commits, as parseSlope does, clamped to 0 to 5 mm. */
export function parseHeight(text: string): number | undefined | null {
  return parseClamped(text, HEIGHT_MIN, HEIGHT_MAX)
}

function parseClamped(text: string, min: number, max: number): number | undefined | null {
  const t = text.trim()
  if (t === '') return undefined
  const n = Number(t)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/** Sets slot `slot`'s entry of the per-filament list `key` in the plate overrides (undefined clears it) and marks the slice stale. */
export function setSlotValue(key: string, slot: number, slotCount: number, value: number | string | undefined, inherited?: SettingValue): void {
  set((s) => ({ overrides: withSlotValue(key, s.overrides, slot, slotCount, value, inherited) }))
  markStale()
}

/** Slot `slot`'s own Z hop height in mm, or undefined when it uses the printer's. */
export function slotHeight(values: Values, slot: number): number | undefined {
  return asNumber(slotEntry(values[HEIGHT_KEY], slot))
}

/** Slot `slot`'s own Z hop type (its value, such as "Ramp Lift"), or undefined when it uses the printer's. */
export function slotType(values: Values, slot: number): string | undefined {
  const e = slotEntry(values[TYPE_KEY], slot)
  return unset(e) ? undefined : String(e)
}

/** The name the app shows for a lift type's value. */
export function liftTypeLabel(value: string): string {
  return LIFT_TYPES.find((t) => t.value === value)?.label ?? value
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

function firmwareRetracts(config: Values): boolean {
  const v = config['use_firmware_retraction']
  const fw = Array.isArray(v) ? v[0] : v
  return fw === true || fw === 1 || fw === '1' || fw === 'true'
}

function mm(n: number): string {
  return `${Number(n.toFixed(2))} mm`
}

/** The line under the Z hop height field: how high the filament lifts, and when it does not lift at all. */
export function heightHint(config: Values, slot: number): string {
  const own = slotHeight(config, slot)
  const first = (v: SettingValue | undefined) => (Array.isArray(v) ? v[0] : v)
  const lines = [
    own === undefined
      ? `Uses the printer's Z hop height, ${mm(asNumber(first(config['z_hop'])) ?? 0)}.`
      : own === 0
        ? 'At 0 mm, this filament does not lift.'
        : `Lifts ${mm(own)} for this filament.`,
  ]
  if (firmwareRetracts(config)) lines.push('This printer retracts with its own firmware commands, so Z hop is not used.')
  return lines.join(' ')
}

/** The line under the Z hop type field: the type the filament lifts with, and when the type has no effect. */
export function typeHint(config: Values, slot: number): string {
  const own = slotType(config, slot)
  const lift = slotLift(config, slot)
  const lines = [own === undefined ? `Uses the printer's Z hop type, ${liftTypeLabel(lift.type)}.` : `Lifts with ${liftTypeLabel(own)} for this filament.`]
  if (firmwareRetracts(config)) lines.push('This printer retracts with its own firmware commands, so the type is not used.')
  else if (lift.height <= 0) lines.push('Z hop height is 0, so there is no lift.')
  return lines.join(' ')
}
