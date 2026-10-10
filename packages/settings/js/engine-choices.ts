// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened project's settings come from the file, except a few engine choices of SlicerX, which stay ours unless the
// person changed them in the project. The app's project open and the MCP server's project_settings both use this, so a
// project slices the same either way.
import { LEGACY_KEYS } from './import'

/**
 * Engine choices of SlicerX that stay when a project opens, unless the person changed them in the project (its
 * different_settings_to_system lists the key): every other value the project inherited from its presets comes from the
 * file. Each says, in the open's note, what it kept when the project's inherited value differs.
 */
export const SLICERX_KEEPS: Readonly<Record<string, string>> = {
  // aegis: wall widths fitted to the part, so thin features print solid with fewer width changes than Arachne or
  // Bambu Studio's classic walls (the app's SLICERX_PRESET_DEFAULTS sets it over every maker preset).
  wall_generator: "Kept SlicerX's aegis walls; the project used Bambu's default.",
  // The outer wall spaced from the inner walls so that the outline, not the wall's center, lands on the model's size.
  precise_outer_wall: "Kept SlicerX's precise outer wall; the project used Bambu's default.",
}

/**
 * The keys a project lists as changed from its system presets (`different_settings_to_system`: the process, then each
 * filament, then the printer), in our key names. Undefined when the file does not say, so every key counts.
 */
export function changedKeys(settings: Record<string, unknown>): Set<string> | undefined {
  const v = settings['different_settings_to_system']
  if (!Array.isArray(v)) return undefined
  const out = new Set<string>()
  for (const entry of v) {
    if (typeof entry !== 'string') continue
    for (const k of entry.split(';').map((x) => x.trim()).filter(Boolean)) out.add(LEGACY_KEYS[k] ?? k)
  }
  return out
}

/** The engine choices a project leaves to SlicerX: those its file does not list as changed. None when it does not say. */
export function keptEngineChoices(settings: Record<string, unknown>): string[] {
  const changed = changedKeys(settings)
  return changed ? Object.keys(SLICERX_KEEPS).filter((k) => !changed.has(k)) : []
}
