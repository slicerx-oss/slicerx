// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// State shared by the tools of one mimir instance: slice results per plate,
// so queueing sends exactly the G-code that was sliced and approved.
import type { GcodeExport, SliceResult } from '@slicerx/contracts'

export interface SlicedPlate {
  plate: number
  result: SliceResult
  gcode?: GcodeExport
  /** Bytes of the exported G-code, kept so upload sends what the approval hashed. */
  data?: ArrayBuffer
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
