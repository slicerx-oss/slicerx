// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate type a slice prints on when the plate sets none: the print settings', else the printer's default. The engine
// reads it as `curr_bed_type` to pick the bed temperatures. The app's plates and the MCP server's slices use it.

/** The plate types, as the app's plate settings name them. */
export type BedType = 'cool' | 'engineering' | 'high-temp' | 'textured-pei' | 'smooth-pei'

/** Orca's `curr_bed_type` names. Bambu's smooth PEI plate is Orca's High Temp Plate. */
export const BED_TYPE_ENGINE: Readonly<Record<BedType, string>> = {
  cool: 'Cool Plate',
  engineering: 'Engineering Plate',
  'high-temp': 'High Temp Plate',
  'textured-pei': 'Textured PEI Plate',
  'smooth-pei': 'High Temp Plate',
}

// Orca's BedType enum: 1 Cool Plate, 2 Engineering Plate, 3 High Temp Plate, 4 Textured PEI Plate.
const BY_NUMBER: Readonly<Record<number, BedType>> = { 1: 'cool', 2: 'engineering', 3: 'smooth-pei', 4: 'textured-pei' }

const BY_NAME: Readonly<Record<string, BedType>> = {
  'cool plate': 'cool',
  'engineering plate': 'engineering',
  'high temp plate': 'smooth-pei',
  'textured pei plate': 'textured-pei',
}

/**
 * A printer profile's `default_bed_type`, as a number (Orca's legacy form) or a name. Orca 2.4.2 reads only the
 * number and falls back to High Temp Plate; a name is read here too, so profiles that write one get their plate.
 */
export function printerBedType(cfg: Readonly<Record<string, unknown>>): BedType | undefined {
  const raw = cfg['default_bed_type']
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (Number.isInteger(n) && n > 0) return BY_NUMBER[n]
  return BY_NAME[String(v).trim().toLowerCase()]
}

/** The plate type the print settings name in `curr_bed_type`, as a project's settings do. */
export function settingsBedType(cfg: Readonly<Record<string, unknown>>): BedType | undefined {
  const raw = cfg['curr_bed_type']
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' ? BY_NAME[v.trim().toLowerCase()] : undefined
}

/**
 * The `curr_bed_type` a slice prints with when its plate sets no plate type, to spread over the print settings: a
 * `curr_bed_type` already in the settings stays as it is, even one the app's picker does not list (a Supertack plate);
 * else the print settings' plate, the printer's default, or smooth PEI (Orca's High Temp Plate).
 */
export function sliceBedType(cfg: Readonly<Record<string, unknown>>): { curr_bed_type?: string } {
  if (typeof cfg['curr_bed_type'] === 'string' && cfg['curr_bed_type']) return {}
  return { curr_bed_type: BED_TYPE_ENGINE[settingsBedType(cfg) ?? printerBedType(cfg) ?? 'smooth-pei'] }
}
