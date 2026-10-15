// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ToolheadNeed } from '@slicerx/contracts'
import type { MapFilament } from './options'

/** Use the sliced plate's materials, including composites and support tools. */
export function toolheadNeedsForPlate(grams: readonly number[], config: Record<string, unknown>, filaments: readonly MapFilament[]): ToolheadNeed[] {
  const value = (key: string, tool: number): string | undefined => {
    const raw = config[key]
    const entry = Array.isArray(raw) ? raw[tool] ?? (raw.length === 1 ? raw[0] : undefined) : raw
    return typeof entry === 'string' && entry.trim() ? entry : undefined
  }
  return grams.flatMap((amount, tool) => {
    if (amount <= 0) return []
    const filament = filaments.find((f) => f.index === tool + 1)
    return [{ tool, material: value('filament_type', tool) ?? filament?.type ?? '', color: value('filament_colour', tool) ?? filament?.color ?? '' }]
  })
}
