// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate type a slice prints on when the plate sets none: the print settings', else the printer's default. The engine
// reads it as `curr_bed_type` to pick the bed temperatures. The app's plates and the MCP server's slices use it.

/** The plate types, as the app's plate settings name them. */
export type BedType = 'cool' | 'engineering' | 'high-temp' | 'textured-pei' | 'smooth-pei' | 'textured-cool' | 'supertack'

/** Orca's `curr_bed_type` names. Bambu's smooth PEI plate is Orca's High Temp Plate. */
export const BED_TYPE_ENGINE: Readonly<Record<BedType, string>> = {
  cool: 'Cool Plate',
  engineering: 'Engineering Plate',
  'high-temp': 'High Temp Plate',
  'textured-pei': 'Textured PEI Plate',
  'smooth-pei': 'High Temp Plate',
  'textured-cool': 'Textured Cool Plate',
  supertack: 'Supertack Plate',
}

/** The plate types in the order the app's pickers list them, with the names a person sees. */
export const BED_TYPE_OPTIONS: readonly { value: BedType; label: string }[] = [
  { value: 'textured-pei', label: 'Textured PEI' },
  { value: 'smooth-pei', label: 'Smooth PEI' },
  { value: 'cool', label: 'Cool plate' },
  { value: 'engineering', label: 'Engineering plate' },
  { value: 'high-temp', label: 'High temp plate' },
  { value: 'textured-cool', label: 'Textured cool plate' },
  { value: 'supertack', label: 'Supertack plate' },
]

/** A plate name folded for matching: lowercase, dashes and underscores as spaces, single spaces, no trailing "plate". */
const fold = (name: string): string => name.trim().toLowerCase().replace(/[-_\s]+/g, ' ').replace(/ plate$/, '')

/**
 * The plate type a person or a client names, as the pickers label it ("Textured PEI", "Cool plate"), in any letter
 * case, with or without "plate", and with dashes for spaces (`textured-pei`, the app's own value). Undefined for a
 * name no plate type has.
 */
export function bedTypeByName(name: string): BedType | undefined {
  const want = fold(name)
  return want ? BED_TYPE_OPTIONS.find((o) => fold(o.label) === want)?.value : undefined
}

/** The setting that holds each plate type's bed temperature per filament; `<key>_initial_layer` holds the first layer's. */
export const BED_TYPE_TEMP_KEY: Readonly<Record<BedType, string>> = {
  cool: 'cool_plate_temp',
  engineering: 'eng_plate_temp',
  'high-temp': 'hot_plate_temp',
  'textured-pei': 'textured_plate_temp',
  'smooth-pei': 'hot_plate_temp',
  'textured-cool': 'textured_cool_plate_temp',
  supertack: 'supertack_plate_temp',
}

// Orca's BedType enum: 1 Cool Plate, 2 Engineering Plate, 3 High Temp Plate, 4 Textured PEI Plate.
const BY_NUMBER: Readonly<Record<number, BedType>> = { 1: 'cool', 2: 'engineering', 3: 'smooth-pei', 4: 'textured-pei' }

const BY_NAME: Readonly<Record<string, BedType>> = {
  'cool plate': 'cool',
  'engineering plate': 'engineering',
  'high temp plate': 'smooth-pei',
  'textured pei plate': 'textured-pei',
  'textured cool plate': 'textured-cool',
  'supertack plate': 'supertack',
}

/**
 * Every plate type a project file can name in `curr_bed_type`, by its lowercase name, as the engine names it. A plate's
 * own entry in the file may spell the Supertack plate "SuperTack Plate"; "Default Plate" means the printer's default.
 */
const PROJECT_PLATES: Readonly<Record<string, string>> = {
  'cool plate': 'Cool Plate',
  'engineering plate': 'Engineering Plate',
  'high temp plate': 'High Temp Plate',
  'textured pei plate': 'Textured PEI Plate',
  'textured cool plate': 'Textured Cool Plate',
  'supertack plate': 'Supertack Plate',
}

/**
 * The plate type a project file's settings name in `curr_bed_type`, as the engine reads it, for the slice to keep.
 * Undefined for "Default Plate" (the printer's default then counts, as for a file with none) and for a name no plate has.
 */
export function projectBedType(settings: Readonly<Record<string, unknown>>): string | undefined {
  const raw = settings['curr_bed_type']
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' ? PROJECT_PLATES[v.trim().toLowerCase()] : undefined
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
 * The plate type a plate of a project file names for itself, from its metadata in Metadata/model_settings.config:
 * `bed_type`, as project files write it, else `curr_bed_type`, as SlicerX saves it. Undefined for "Default
 * Plate" (the project's plate type, else the printer's default, then counts) and for a name no plate has.
 */
export function filePlateBedType(meta: Readonly<Record<string, string | undefined>>): BedType | undefined {
  const v = meta['bed_type'] ?? meta['curr_bed_type']
  return v === undefined ? undefined : BY_NAME[v.trim().toLowerCase()]
}

/**
 * The `curr_bed_type` a slice prints with when its plate sets no plate type, to spread over the print settings: a
 * `curr_bed_type` already in the settings stays as it is, even one no plate type here names;
 * else the print settings' plate, the printer's default, or smooth PEI (Orca's High Temp Plate).
 */
export function sliceBedType(cfg: Readonly<Record<string, unknown>>): { curr_bed_type?: string } {
  if (typeof cfg['curr_bed_type'] === 'string' && cfg['curr_bed_type']) return {}
  return { curr_bed_type: BED_TYPE_ENGINE[settingsBedType(cfg) ?? printerBedType(cfg) ?? 'smooth-pei'] }
}
