// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selected printer's tool changer for Preview: built from the resolved settings and the profile id,
// kept while nothing it depends on changes so the playback bar and the viewport share one object.
import { printerProfile } from '@slicerx/settings'
import { toolChangerSpec, type ToolChangerSpec } from '@slicerx/viewport'
import { resolveConfig } from '../adapters/config'
import type { AppState } from '../state/store'

let last: { key: readonly unknown[]; spec: ToolChangerSpec | null } | null = null

/**
 * Null for a printer with one nozzle. The same object comes back until the printer, its settings, the bed or the slice
 * changes. On a printer with a filament map (H2D, H2C) the extruders are the ones the slice printed with. An IDEX
 * print in a copy mode (`copyMode`, for the preview shown) has none.
 */
export function toolChangerFor(s: Pick<AppState, 'profile' | 'overrides' | 'easy' | 'bed' | 'preview'> & Partial<Pick<AppState, 'slice' | 'copyMode'>>): ToolChangerSpec | null {
  const tools = s.preview?.toolCount ?? 1
  const map = s.slice?.status === 'done' ? s.slice.result.filamentMap?.extruders : undefined
  // A copy mode read from this preview's start G-code: both IDEX carriages print, nothing parks.
  const copy = !!s.copyMode && s.copyMode.preview === s.preview
  const key = [s.profile, s.overrides, s.easy, s.bed, tools, map, copy] as const
  if (last && last.key.every((k, i) => k === key[i])) return last.spec
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, unknown>
  // The catalog's kinematics tell an IDEX printer's two carriages from one head with two nozzles.
  const kinematics = s.profile ? printerProfile(s.profile.printerId)?.kinematics : undefined
  const hints = { ...(kinematics ? { kinematics } : {}), ...(copy ? { copy } : {}) }
  const spec = s.profile ? toolChangerSpec(s.profile.printerId, map ? { ...cfg, filament_map: map } : cfg, s.bed, tools, hints) : null
  last = { key, spec }
  return spec
}
