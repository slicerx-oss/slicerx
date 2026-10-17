// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { LoadedToolhead, ToolheadAssignment, ToolheadNeed, ToolheadPlan } from '@slicerx/contracts'
import { colorName } from '../filament/rail'
import type { MapFilament } from './options'

/** What a toolhead holds, in words: "PLA HIGH SPEED Red". Empty for an empty head or one that reports nothing. */
export function headFilament(head: LoadedToolhead | undefined, dataAvailable: boolean): string {
  if (!dataAvailable || !head?.loaded) return ''
  return [head.material ?? 'Unknown material', head.color ? colorName(head.color) : ''].filter(Boolean).join(' ')
}

/**
 * The one reason a toolhead row shows, most important first: an empty head, then a different material, then a different
 * color. `more` holds the others for the tooltip, `warn` is false for a color-only difference.
 */
export function toolheadWarning(a: ToolheadAssignment, dataAvailable: boolean): { text: string; more: string[]; warn: boolean } {
  if (!dataAvailable) return { text: a.reason, more: [], warn: false }
  // the plan's own wording for each reason, in its own order; the ranking below is the sheet's
  const pieces = a.reason.split('; ')
  const say = (pattern: RegExp, fallback: string) => pieces.find((p) => pattern.test(p)) ?? fallback
  const ranked: Array<[string, boolean]> = []
  if (a.empty) ranked.push([say(/empty/i, 'The selected toolhead is empty'), true])
  if (a.materialMismatch) ranked.push([say(/material/i, 'Material differs from the print filament'), true])
  if (a.colorMismatch) ranked.push([say(/colou?r/i, 'Color differs from the print filament'), false])
  const first = ranked[0]
  if (!first) return { text: a.reason, more: [], warn: false }
  return { text: first[0], more: ranked.slice(1).map(([text]) => text), warn: first[1] }
}

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
  const matches = plan.assignments.length > 0 && plan.assignments.every((a) => (a.status === 'match' || a.status === 'selected') && !a.colorMismatch && !a.materialMismatch && !a.empty)
  const selected = plan.assignments.flatMap((a) => a.physicalTool == null ? [] : [a.physicalTool])
  const sharesSpool = new Set(selected).size < selected.length
  return !matches || sharesSpool || (plan.assignments.length > 1 && !skipMatching)
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
