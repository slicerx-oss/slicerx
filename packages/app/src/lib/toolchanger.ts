// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The selected printer's tool changer for Preview: built from the resolved settings and the profile id,
// kept while nothing it depends on changes so the playback bar and the viewport share one object.
import { toolChangerSpec, type ToolChangerSpec } from '@slicerx/viewport'
import { resolveConfig } from '../adapters/config'
import type { AppState } from '../state/store'

let last: { key: readonly unknown[]; spec: ToolChangerSpec | null } | null = null

/**
 * Null for a printer with one nozzle. The same object comes back until the printer, its settings, the bed or the slice
 * changes. On a printer with a filament map (H2D, H2C) the extruders are the ones the slice printed with.
 */
export function toolChangerFor(s: Pick<AppState, 'profile' | 'overrides' | 'easy' | 'bed' | 'preview'> & Partial<Pick<AppState, 'slice'>>): ToolChangerSpec | null {
  const tools = s.preview?.toolCount ?? 1
  const map = s.slice?.status === 'done' ? s.slice.result.filamentMap?.extruders : undefined
  const key = [s.profile, s.overrides, s.easy, s.bed, tools, map] as const
  if (last && last.key.every((k, i) => k === key[i])) return last.spec
  const cfg = resolveConfig(s.easy, s.overrides) as Record<string, unknown>
  const spec = s.profile ? toolChangerSpec(s.profile.printerId, map ? { ...cfg, filament_map: map } : cfg, s.bed, tools) : null
  last = { key, spec }
  return spec
}
