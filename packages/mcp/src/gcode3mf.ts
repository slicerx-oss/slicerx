// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sliced plate as a .gcode.3mf the way Bambu Lab printers and print queues take it, written by the app's own writer
// (@slicerx/threemf): Metadata/plate_1.gcode with its MD5, slice_info.config and plate_1.json with the time, weight,
// filaments and object boxes from the G-code, model_settings.config pointing at the G-code, project_settings.config
// with the settings it was sliced with, and the plate pictures the engine drew. Like Bambu Studio's upload to a
// printer, it carries no geometry, so it is for printing, not for editing.
import type { SettingValue } from '@slicerx/contracts'
import { productName } from '@slicerx/contracts'
import { settingDef, toOrca } from '@slicerx/settings'
import { entryData, gcodeLabelIds, projectFiles } from '@slicerx/threemf'
import type { SliceSummary } from './slicer'
import { writeZip } from './zip'

/** Thumbnail sizes asked of the engine for a .gcode.3mf when the settings name none: the plate picture and its small copy. */
export const PLATE_THUMBNAILS = ['512x512/PNG', '128x128/PNG']

/** The slice settings as Orca writes them in project_settings.config, as the app's export does. */
function orcaSettings(config: Readonly<Record<string, SettingValue>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    const def = settingDef(k)
    out[k] = def ? toOrca(def, v) : v
  }
  return out
}

export function gcode3mf(sliced: string, summary: SliceSummary, config: Record<string, SettingValue>): Buffer {
  // The objects the printer's skip dialog lists, in the order the G-code labels them, named after the model.
  const printNames = gcodeLabelIds(sliced).map((_, k) => (k === 0 ? summary.model.name : `${summary.model.name} ${k + 1}`))
  const files = projectFiles({
    plates: [{ name: '', objects: [], settings: {}, printNames }],
    bed: { widthMm: 0, depthMm: 0 },
    settings: orcaSettings(config),
    application: productName(),
    gcode: { 0: sliced },
  })
  return writeZip(entryData(files))
}
