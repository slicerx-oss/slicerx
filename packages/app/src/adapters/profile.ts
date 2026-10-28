// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selected printer, filament and process presets as one layer under the Easy choices: the maker's printer
// (bed, speeds, accelerations, machine limits, retraction), the filament in each slot and the quality tier's
// process, resolved the way OrcaSlicer 2.4.2 resolves them (packages/profiles/resolved), plus the G-code
// written for SlicerX. Loaded on demand with the rest of the settings.
import type { Bed, EasyGoal, PrintConfig, SettingValue } from '@slicerx/contracts'
import { stockLayer, type SlotFilament } from '@slicerx/settings'
import { profileIdFor } from '../workspaces/prepare/printer-base'
import { point } from '../plate/bed-origin'
import { circleOfArea } from '../plate/bed-shape'
import { GENERIC_BED } from './generic-bed'

export { applyExtruders, GCODE_KEYS, perSlot, pickExtruderVariant, pickVariant, type SlotFilament } from '@slicerx/settings'

export interface ProfileInput {
  printer: { vendor: string; model: string }
  tier: EasyGoal
  slots: readonly SlotFilament[]
  /** The nozzle size in mm. The printer's default when absent. */
  nozzle?: number
  /** Where the size came from, for showing it. */
  nozzleFrom?: 'printer' | 'choice' | 'default'
  /** Each extruder's nozzle on a printer with more than one, in the slicer's extruder order (left first on an H2D). */
  extruders?: readonly { mm: number; type?: string }[]
}

export interface ProfileLayer {
  printerId: string
  nozzle: number
  nozzles: number[]
  nozzleFrom: 'printer' | 'choice' | 'default'
  tier: EasyGoal
  /** Where the settings come from: Orca's resolved system presets, or our own profile for models Orca has no preset for. */
  source: 'orca' | 'slicerx'
  values: Record<string, SettingValue>
  bed: Bed
  limits: { nozzleMaxC?: number; bedMaxC?: number }
  /** The custom G-code in this layer is the shipped text for the model, so the engine may trust it. */
  shippedGcode: boolean
  /** Keys that carry G-code text, so a user override of one can withdraw the trust. */
  gcodeKeys: string[]
  /** Each slot's filament preset id (`filament_id`, such as `GFA00`), in slot order; empty where no shipped preset applies. */
  filamentIds: string[]
  /** The material of the maker's default filament for the printer (PLA, PETG), empty without a resolved preset. */
  materialType: string
  /** The layer height and walls each goal's process gives on this printer and nozzle, for the Goal tiles. */
  goalValues: Record<EasyGoal, Record<string, SettingValue>>
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v)

export function bedOf(values: Record<string, SettingValue>): Bed {
  const area = values['printable_area']
  const pts = Array.isArray(area) ? (area as unknown[]).map(point).filter((p): p is [number, number] => p !== null) : []
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const h = Number(first(values['printable_height']))
  const height = Number.isFinite(h) && h > 0 ? h : GENERIC_BED.heightMm
  if (!xs.length) return { widthMm: GENERIC_BED.widthMm, depthMm: GENERIC_BED.depthMm, heightMm: height }
  const box = { widthMm: Math.max(...xs) - Math.min(...xs), depthMm: Math.max(...ys) - Math.min(...ys), heightMm: height }
  return circleOfArea(area) ? { ...box, round: true } : box
}

/** The layer for a printer, tier and slot filaments. Null when the printer matches none of our profiles. */
export async function buildProfileLayer(input: ProfileInput): Promise<ProfileLayer | null> {
  const printerId = profileIdFor(input.printer)
  if (!printerId) return null
  const layer = await stockLayer({ printerId, tier: input.tier, slots: input.slots, nozzle: input.nozzle, extruders: input.extruders })
  if (!layer) return null
  return { ...layer, nozzleFrom: input.nozzleFrom ?? 'default', bed: bedOf(layer.values) }
}

export type { PrintConfig }
