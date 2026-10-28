// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate type a plate prints on: its own, or the printer's default. The engine reads it as `curr_bed_type` to pick
// the bed temperatures, so a plate type set by hand has to reach the slice, not only the plate card.
import type { PlateMeta, PlateSettings } from '../state/store'
import { BED_TYPE_ENGINE, printerBedType, settingsBedType, sliceBedType } from '@slicerx/settings/bed-type'

// The engine's plate type names and how a printer or the print settings name a plate are shared with the MCP server.
export { BED_TYPE_ENGINE, printerBedType, settingsBedType }

export type BedType = NonNullable<PlateSettings['bedType']>

/** The plate types in the order the pickers list them. */
export const BED_TYPE_OPTIONS: readonly { value: BedType; label: string }[] = [
  { value: 'textured-pei', label: 'Textured PEI' },
  { value: 'smooth-pei', label: 'Smooth PEI' },
  { value: 'cool', label: 'Cool plate' },
  { value: 'engineering', label: 'Engineering plate' },
  { value: 'high-temp', label: 'High temp plate' },
]

const label = (v: BedType): string => BED_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? v

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
  return sliceBedType(cfg)
}
