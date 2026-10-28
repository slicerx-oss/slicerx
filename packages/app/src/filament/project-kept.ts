// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened project's own flush volumes and prime tower spot. A project's values come from the file, so the slice keeps
// the matrix and multiplier it was saved with while its filament slots are as the file has them, and the tower stays
// where the file put it until the person moves it. Plain models and new plates keep the values worked out from the slots.
import { resolveConfig } from '../adapters/config'
import { areaOrigin } from '../plate/bed-origin'
import { get, set } from '../state/store'
import { plateTowerIndexes, projectFlushFrom, projectTowerFrom } from '@slicerx/settings/slot-settings'

// The project's flush matrix and tower spots as the file has them, shared with the MCP server's project slices.
export { keptFlush, plateTowerIndexes, projectFlushFrom, projectTowerFrom, type ProjectFlush } from '@slicerx/settings/slot-settings'

/**
 * Keeps an opened project's flush volumes and tower spots: each of `plates` (the app's plate ids, in the file's order,
 * with the file's plate numbers) stands its tower at its own entry of the file's spot, and the shown plate's goes in
 * the tower state. Returns the line for the open's note, or '' when the file has neither.
 */
export function keepProjectFlushAndTower(settings: Record<string, unknown>, plates: readonly { id: string; plateNo?: number }[] = [{ id: get().activePlate }]): string {
  const flush = projectFlushFrom(settings)
  const origin = areaOrigin(resolveConfig(get().easy, get().overrides)['printable_area'])
  const indexes = plateTowerIndexes(plates.map((p) => p.plateNo))
  const towers: Record<string, { x: number; y: number } | null> = {}
  for (const [i, p] of plates.entries()) towers[p.id] = indexes[i] === null ? null : projectTowerFrom(settings, origin, indexes[i])
  const kept = Object.values(towers).some(Boolean)
  const shown = towers[get().activePlate]
  set({ projectFlush: flush, towerFromProject: kept, projectTowers: kept ? towers : {}, ...(kept ? { tower: shown ? { auto: false, ...shown } : { auto: true, x: 0, y: 0 } } : {}) })
  const note = [flush ? 'flush volumes' : '', kept ? 'prime tower position' : ''].filter(Boolean)
  return note.length ? `Kept the project's ${note.join(' and ')}.` : ''
}
