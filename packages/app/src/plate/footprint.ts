// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the printer lays down around an object, as arrange and the off-the-bed checks need it: the brim
// (an automatic brim sized the way the engine sizes it), the raft, the support pad, the size
// compensation, and the skirt or draft shield around the whole print. Read from the same resolved
// configuration the slice uses, so the plate and the slice agree on how far the first layer reaches. The
// engine's own checks stay as they are; this only keeps arrange from placing what they would block.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { usedSlots } from '../filament/slots'
import type { AppState } from '../state/store'
import { MARGIN_SAFETY_MM, setMarginSource, type PrintMargins, type Rect } from './arrange'
import { plateConfig } from './plates'
import { areaOrigin } from './bed-origin'
import { objectPrintMargins, marginNumber as num, marginText as text, marginFlag as flag } from '@slicerx/settings/print-margins'
export { autoBrimWidth } from '@slicerx/settings/print-margins'

type Inputs = Pick<AppState, 'easy' | 'overrides' | 'plate' | 'plates' | 'activePlate'>

/** The room the prime tower takes when the plate prints in two or more filaments, at its configured place. */
function towerOf(cfg: Record<string, SettingValue>, tools: number): Rect[] {
  if (tools < 2 || !flag(cfg['enable_prime_tower'])) return []
  // The configuration places the tower on the machine; the plate counts from the printable area's corner.
  const [ox, oy] = areaOrigin(cfg['printable_area'])
  const x = num(cfg['wipe_tower_x'], 15) - ox
  const y = num(cfg['wipe_tower_y'], 220) - oy
  const side = Math.max(5, num(cfg['prime_tower_width'], 35))
  const pad = Math.max(0, num(cfg['prime_tower_brim_width'], 3)) + 1
  return [{ x: x - pad, y: y - pad, w: side + 2 * pad, h: side + 2 * pad }]
}

/** The margins for a configuration and the number of filaments the plate prints in. */
export function marginsFor(cfg: Record<string, SettingValue>, tools = 1): PrintMargins {
  const keepOut = towerOf(cfg, tools)
  // Orca and Bambu Studio arrange a by-object plate with the extruder clearance between objects (Arrange.cpp).
  const byObject = text(cfg['print_sequence']) === 'by object'
  return {
    ...(byObject ? { apart: Math.max(0, num(cfg['extruder_clearance_radius'], 40)) + MARGIN_SAFETY_MM } : {}),
    ...objectPrintMargins(cfg),
    keepOut,
  }
}

let cached: { easy: unknown; overrides: unknown; plate: unknown; plates: unknown; activePlate: unknown; margins: PrintMargins } | null = null

/** The margins for the plate on screen, from the resolved configuration a slice of it would use. */
export function printMargins(s: Inputs): PrintMargins {
  if (cached && cached.easy === s.easy && cached.overrides === s.overrides && cached.plate === s.plate && cached.plates === s.plates && cached.activePlate === s.activePlate) return cached.margins
  const cfg = { ...resolveConfig(s.easy, s.overrides), ...plateConfig(s.plates.find((p) => p.id === s.activePlate)) } as PrintConfig & Record<string, SettingValue>
  const margins = marginsFor(cfg, usedSlots(s).size)
  cached = { easy: s.easy, overrides: s.overrides, plate: s.plate, plates: s.plates, activePlate: s.activePlate, margins }
  return margins
}

/** Makes arrange and the bed checks read the margins of the plate in the store. Call once with the store's getter. */
export function installPrintMargins(read: () => Inputs): void {
  setMarginSource(() => printMargins(read()))
}
