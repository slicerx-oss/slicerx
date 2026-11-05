// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Body colors from a CAD file as filaments, planned the way the app plans them on import (@slicerx/contracts
// color-slots): a color close to a filament the project has prints with it, one that is not gets a filament of its
// own while the limit allows, else the nearest. slicerx_step_read reports the plan; slicerx_project_add_model applies it.
import { planColorSlots, type ColorSlotPlan } from '@slicerx/contracts'
import { defaultFilament, MAX_FILAMENTS } from './filaments'

/** A filament the plan starts from: its color, and whether a new color may take it over (nothing prints with it). */
export interface PlanFilament {
  color: string
  free?: boolean
}

/**
 * The plan for `colors` (one per body, null for a body without a color) against `filaments` (filament 1 first). Without
 * them it plans for a new project, whose one filament has the default color and is taken over by the first color
 * unless a body without a color prints with it. `max` is the most filaments the project may end up with.
 */
export function planBodyFilaments(colors: readonly (string | null)[], filaments: readonly PlanFilament[] | undefined, max: number = MAX_FILAMENTS): ColorSlotPlan {
  const start = filaments ?? [{ color: defaultFilament(1, 'PLA').color, free: !colors.some((c) => !c) }]
  return planColorSlots(colors, start.map((f, i) => ({ index: i + 1, color: f.color, free: f.free ?? false })), { limit: Math.min(MAX_FILAMENTS, max) })
}
