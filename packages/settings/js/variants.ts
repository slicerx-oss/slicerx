// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Bambu Studio 2's project settings with its per-variant values down to the ones that slice. The app's project open and
// the MCP server's project_settings both read a project through this, so a project slices the same either way.

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * The project's settings with Bambu Studio's per-variant values down to the ones that apply. Bambu Studio 2 writes some
 * process values once per extruder and hotend variant (`print_extruder_id` and `print_extruder_variant`: standard, high
 * flow, TPU) and some filament values once per filament and variant (`filament_extruder_variant`). The one that slices
 * is each extruder's own variant, its `extruder_type` and `nozzle_volume_type` ("Direct Drive Standard"): a process
 * value becomes one per extruder, a filament value one per filament.
 */
export function selectVariants(raw: Record<string, unknown>): Record<string, unknown> {
  const ids = list(raw['print_extruder_id'])
  const pv = list(raw['print_extruder_variant'])
  const fv = list(raw['filament_extruder_variant'])
  const types = list(raw['extruder_type'])
  const volumes = list(raw['nozzle_volume_type'])
  const filaments = list(raw['filament_settings_id']).length || list(raw['filament_colour']).length
  const extruders = [...new Set(ids)].sort((a, b) => Number(a) - Number(b))
  const active = (e: number): string => `${types[e] ?? types[0] ?? 'Direct Drive'} ${volumes[e] ?? volumes[0] ?? 'Standard'}`
  const out: Record<string, unknown> = { ...raw }
  const skip = new Set(['print_extruder_id', 'print_extruder_variant', 'filament_extruder_variant', 'printer_extruder_id', 'printer_extruder_variant'])
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v) || skip.has(k)) continue
    if (pv.length > extruders.length && extruders.length > 0 && v.length === pv.length && ids.length === pv.length) {
      out[k] = extruders.map((id, e) => {
        const at = pv.findIndex((name, i) => ids[i] === id && name === active(e))
        return v[at >= 0 ? at : ids.indexOf(id)]
      })
    } else if (filaments > 0 && fv.length > filaments && fv.length % filaments === 0 && v.length === fv.length) {
      const per = fv.length / filaments
      out[k] = Array.from({ length: filaments }, (_, f) => {
        const j = fv.slice(f * per, f * per + per).indexOf(active(0))
        return v[f * per + (j >= 0 ? j : 0)]
      })
    }
  }
  return out
}
