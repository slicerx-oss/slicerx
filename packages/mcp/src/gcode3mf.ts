// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sliced plate as a .gcode.3mf the way Bambu Lab printers and print queues take it, written by the app's own writer
// (@slicerx/threemf): Metadata/plate_1.gcode with its MD5, slice_info.config and plate_1.json with the time, weight,
// filaments and object boxes from the G-code, model_settings.config pointing at the G-code, project_settings.config
// with the settings it was sliced with, and the plate pictures the engine drew. Like Bambu Studio's upload to a
// printer, it carries no geometry, so it is for printing, not for editing.
import type { SettingValue } from '@slicerx/contracts'
import type { VaultMark } from '@slicerx/contracts/sx3mf-marks'
import { productName } from '@slicerx/contracts'
import { orcaReadable, settingDef, toOrca, withoutRefusedValues } from '@slicerx/settings'
import { entryData, gcodeLabelIds, projectFiles } from '@slicerx/threemf'
import type { SliceSummary } from './slicer'
import { writeZip } from './zip'
import { evenFilamentLists } from '@slicerx/settings/slot-settings'

/** Thumbnail sizes asked of the engine for a .gcode.3mf when the settings name none: the plate picture and its small copy. */
export const PLATE_THUMBNAILS = ['512x512/PNG', '128x128/PNG']

/** The slice settings as Orca writes them in project_settings.config, as the app's export does, in the values Bambu
 * Studio and OrcaSlicer read ([`orcaReadable`]). */
function orcaSettings(config: Readonly<Record<string, SettingValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    const def = settingDef(k)
    out[k] = def ? toOrca(def, v) : v
  }
  return orcaReadable(withoutRefusedValues(out))
}

/**
 * Every per-filament list of the settings with one entry per filament the slice names (the longest of its color and
 * type lists), since readers take the lists together by index; a list the settings give shorter takes its last entry
 * for the rest, as the engine sliced those filaments. A slice of one filament is written as before.
 */
function everyFilament(settings: Record<string, unknown>): Record<string, unknown> {
  const n = (v: unknown): number => (Array.isArray(v) ? v.length : v === undefined ? 0 : 1)
  const filaments = Math.max(n(settings['filament_colour']), n(settings['filament_type']))
  return filaments > 1 ? evenFilamentLists(settings, filaments) : settings
}

/**
 * `vault` is the listing and creator of a Vault design the plate was sliced from (vault.ts, vaultMark). The file then
 * carries them on its root model with the design's name as its title, as the app writes a Vault design's print file:
 * still no mesh, and it reads as a Vault design again. Without it the file is as before.
 */
export function gcode3mf(sliced: string, summary: SliceSummary, config: Record<string, SettingValue>, vault?: VaultMark | null): Buffer {
  // The objects the printer's skip dialog lists, in the order the G-code labels them, named after the model.
  const printNames = gcodeLabelIds(sliced).map((_, k) => (k === 0 ? summary.model.name : `${summary.model.name} ${k + 1}`))
  const files = projectFiles({
    plates: [{ name: '', objects: [], settings: {}, printNames }],
    bed: { widthMm: 0, depthMm: 0 },
    settings: everyFilament(orcaSettings(config)),
    application: productName(),
    gcode: { 0: sliced },
    ...(vault ? { title: summary.model.name, sx: { ...(vault.listing ? { modelId: vault.listing } : {}), ...(vault.creator ? { creatorId: vault.creator } : {}), exportedBy: '' } } : {}),
  })
  return writeZip(entryData(files))
}
