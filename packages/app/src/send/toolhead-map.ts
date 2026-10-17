// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ToolheadNeed, ToolheadPlan } from '@slicerx/contracts'
import type { MapFilament } from './options'

/** The selected spools must still be the ones the person reviewed. */
export function sameSelectedSpools(before: ToolheadPlan, after: ToolheadPlan, selected: Record<number, number>): boolean {
  return [...new Set(Object.values(selected))].every((tool) => {
    const left = before.toolheads.find((head) => head.tool === tool)
    const right = after.toolheads.find((head) => head.tool === tool)
    return left?.loaded === right?.loaded && left?.material === right?.material && left?.color === right?.color
  })
}

/** Missing metadata needs manual choices only for a multi-filament job. */
export function showToolheadChoices(plan: ToolheadPlan, skipMatching: boolean): boolean {
  if (plan.headDataAvailable === false) return plan.assignments.length > 1
  const matches = plan.assignments.length > 0 && plan.assignments.every((a) => a.status === 'match' && !a.colorMismatch && !a.materialMismatch && !a.empty)
  return !skipMatching || !matches
}

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
