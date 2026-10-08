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

/**
 * The plate type a plate prints on, its label, and where it came from. A printer with no default prints on smooth PEI
 * (Orca's High Temp Plate), the plate the engine reads its bed temperatures from when none is set.
 */
export function plateBedType(meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Readonly<Record<string, unknown>>): { value: BedType; label: string; source: 'plate' | 'printer' | 'default' } {
  const own = meta?.settings.bedType
  if (own) return { value: own, label: label(own), source: 'plate' }
  const printer = printerBedType(cfg)
  if (printer) return { value: printer, label: label(printer), source: 'printer' }
  return { value: 'smooth-pei', label: label('smooth-pei'), source: 'default' }
}

/** The `curr_bed_type` a plate slices with. */
export function bedTypeConfig(meta: Pick<PlateMeta, 'settings'> | undefined, cfg: Readonly<Record<string, unknown>>): { curr_bed_type: string } {
  return { curr_bed_type: BED_TYPE_ENGINE[plateBedType(meta, cfg).value] }
}
