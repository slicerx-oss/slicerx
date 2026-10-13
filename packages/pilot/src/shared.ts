// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// State shared by the tools of one mimir instance: slice results per plate,
// so queueing sends exactly the G-code that was sliced and approved.
import type { GcodeExport, PrintConfig, SliceResult } from '@slicerx/contracts'

export interface SlicedPlate {
  plate: number
  result: SliceResult
  gcode?: GcodeExport
  /** Bytes of the exported G-code, kept so upload sends what the approval hashed. */
  data?: ArrayBuffer
  /** The settings the plate was sliced with: its filaments' materials and colors, for matching them to printer slots. */
  config?: PrintConfig
  /** The plate as a .gcode.3mf, for a printer that follows a slot map, kept like `gcode` and `data`. */
  project?: { file: GcodeExport; data: ArrayBuffer }
  /** The slots matched for a send that the person was asked to approve, by printer id, so the start uses what the card showed. */
  autoSlots?: Map<string, Record<number, string>>
}

export interface ToolShared {
  slices: Map<number, SlicedPlate>
  /** Machine cost per hour by printer id, from printer settings. */
  machineRates: Map<string, number>
}

export function createShared(): ToolShared {
  return { slices: new Map(), machineRates: new Map() }
}

export function fmtDuration(s: number): string {
  const m = Math.round(s / 60)
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

export const fmtGrams = (g: number): string => `${g.toFixed(1)} g`
export const fmtMoney = (v: number): string => `$${v.toFixed(2)}`
