// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate type a plate prints on: its own, or the printer's default. The engine reads it as `curr_bed_type` to pick
// the bed temperatures, so a plate type set by hand has to reach the slice, not only the plate card.
import type { PlateMeta, PlateSettings } from '../state/store'

export type BedType = NonNullable<PlateSettings['bedType']>

/** The plate types in the order the pickers list them. */
export const BED_TYPE_OPTIONS: readonly { value: BedType; label: string }[] = [
  { value: 'textured-pei', label: 'Textured PEI' },
  { value: 'smooth-pei', label: 'Smooth PEI' },
  { value: 'cool', label: 'Cool plate' },
  { value: 'engineering', label: 'Engineering plate' },
  { value: 'high-temp', label: 'High temp plate' },
]

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

const label = (v: BedType): string => BED_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v

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
 * The plate type a plate prints on, its label, and where it came from: the plate's own, then the print settings' (a
 * project's), then the printer's default. A printer with no default prints on smooth PEI (Orca's High Temp Plate),
 * the plate the engine reads its bed temperatures from when none is set.
 */
export function plateBedType(meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Readonly<Record<string, unknown>>): { value: BedType; label: string; source: 'plate' | 'settings' | 'printer' | 'default' } {
  const own = meta?.settings.bedType
  if (own) return { value: own, label: label(own), source: 'plate' }
  const settings = settingsBedType(cfg)
  if (settings) return { value: settings, label: label(settings), source: 'settings' }
  const printer = printerBedType(cfg)
  if (printer) return { value: printer, label: label(printer), source: 'printer' }
  return { value: 'smooth-pei', label: label('smooth-pei'), source: 'default' }
}

/**
 * The `curr_bed_type` a plate slices with, to spread over the print settings. A plate type set on the plate wins; a
 * `curr_bed_type` already in the settings stays as it is, even one this picker does not list (a Supertack plate).
 */
export function bedTypeConfig(meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Readonly<Record<string, unknown>>): { curr_bed_type?: string } {
  const own = meta?.settings.bedType
  if (own) return { curr_bed_type: BED_TYPE_ENGINE[own] }
  if (typeof cfg['curr_bed_type'] === 'string' && cfg['curr_bed_type']) return {}
  return { curr_bed_type: BED_TYPE_ENGINE[plateBedType(meta, cfg).value] }
}
