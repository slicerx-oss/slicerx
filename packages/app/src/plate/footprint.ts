// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the printer lays down around an object, as arrange and the off-the-bed checks need it: the brim
// (an automatic brim sized the way the engine sizes it), the raft, the support pad, the size
// compensation, and the skirt or draft shield around the whole print, and the room of the prime tower. Read
// from the same resolved configuration the slice uses, so the plate and the slice agree on how far the first
// layer reaches. The engine's own checks stay as they are; this only keeps arrange from placing what they
// would block.
import type { PrintConfig, SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { usedSlots } from '../filament/slots'
import type { AppState, PlateEntry } from '../state/store'
import { setEntryMarginSource, setMarginSource, type PrintMargins } from './arrange'
import { plateConfig } from './plates'
import { supportedOf } from './sequence-check'
import { areaOrigin, areaSize } from './bed-origin'
import { plateMargins, type TowerState } from '@slicerx/settings/arrange-room'
export { autoBrimWidth } from '@slicerx/settings/print-margins'
export type { TowerState } from '@slicerx/settings/arrange-room'

type Inputs = Pick<AppState, 'easy' | 'overrides' | 'plate' | 'plates' | 'activePlate' | 'tower' | 'slice'>

/**
 * The margins for a configuration, the number of filaments the plate prints in, and the prime tower as the plate has
 * it (without it, the configuration's `prime_tower_auto_position`, `wipe_tower_x` and `wipe_tower_y`).
 */
export function marginsFor(cfg: Record<string, SettingValue>, tools = 1, tower?: TowerState): PrintMargins {
  return plateMargins(cfg, tools, { origin: areaOrigin(cfg['printable_area']), size: areaSize(cfg['printable_area']) }, tower)
}

/** The tower the last slice laid down, while it is on screen. */
function lastTower(s: Pick<AppState, 'slice'>) {
  return s.slice.status === 'done' ? s.slice.result.primeTower : s.slice.status === 'running' ? s.slice.last?.primeTower : undefined
}

let cached: { easy: unknown; overrides: unknown; plate: unknown; plates: unknown; activePlate: unknown; tower: unknown; reported: unknown; margins: PrintMargins } | null = null

/** The margins for the plate on screen, from the resolved configuration a slice of it would use. */
export function printMargins(s: Inputs): PrintMargins {
  const reported = lastTower(s)
  if (cached && cached.easy === s.easy && cached.overrides === s.overrides && cached.plate === s.plate && cached.plates === s.plates && cached.activePlate === s.activePlate && cached.tower === s.tower && cached.reported === reported) return cached.margins
  const cfg = { ...resolveConfig(s.easy, s.overrides), ...plateConfig(s.plates.find((p) => p.id === s.activePlate)) } as PrintConfig & Record<string, SettingValue>
  const tower: TowerState = { ...s.tower, ...(reported ? { size: { width: reported.width, depth: reported.depth, angle: reported.angle } } : {}) }
  const margins = marginsFor(cfg, usedSlots(s).size, tower)
  cached = { easy: s.easy, overrides: s.overrides, plate: s.plate, plates: s.plates, activePlate: s.activePlate, tower: s.tower, reported, margins }
  return margins
}

let bare: { margins: PrintMargins; of: PrintMargins } | null = null

/**
 * The margins for `e` on the plate on screen: the plate's, but with support on, without the support pad when `e` gets
 * no support by sx's rule (supportedOf), as the engine's arrange counts it. An object that may get support keeps it.
 */
export function entryMargins(s: Inputs, e: PlateEntry): PrintMargins {
  const margins = printMargins(s)
  const cfg = { ...resolveConfig(s.easy, s.overrides), ...plateConfig(s.plates.find((p) => p.id === s.activePlate)) } as PrintConfig & Record<string, SettingValue>
  if (!cfg.enable_support || supportedOf(e, cfg)) return margins
  if (bare?.of !== margins) {
    const reported = lastTower(s)
    const tower: TowerState = { ...s.tower, ...(reported ? { size: { width: reported.width, depth: reported.depth, angle: reported.angle } } : {}) }
    bare = { of: margins, margins: marginsFor({ ...cfg, enable_support: false }, usedSlots(s).size, tower) }
  }
  return bare.margins
}

/** Makes arrange and the bed checks read the margins of the plate in the store. Call once with the store's getter. */
export function installPrintMargins(read: () => Inputs): void {
  setMarginSource(() => printMargins(read()))
  setEntryMarginSource((e) => entryMargins(read(), e))
}
