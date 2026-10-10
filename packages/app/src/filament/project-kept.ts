// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An opened project's own flush volumes and prime tower spot. A project's values come from the file, so the slice keeps
// the matrix and multiplier it was saved with while its filament slots are as the file has them, and the tower stays
// where the file put it until the person moves it. Plain models and new plates keep the values worked out from the slots.
import type { SettingValue } from '@slicerx/contracts'
import { resolveConfig } from '../adapters/config'
import { areaOrigin } from '../plate/bed-origin'
import { get, set } from '../state/store'

/** The flush volumes a project was saved with, and the filaments they were worked out for. */
export interface ProjectFlush {
  slots: { color: string; type: string }[]
  /** Filaments in the file; the matrix holds one n by n block per nozzle. */
  n: number
  matrix: number[]
  multiplier: SettingValue
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[;,]/) : [])
const firstNumber = (v: unknown): number => Number(Array.isArray(v) ? v[0] : v)

/** The file's flush matrix, multiplier and filaments, or null when it has no whole matrix for them. */
export function projectFlushFrom(settings: Record<string, unknown>): ProjectFlush | null {
  const colors = list(settings['filament_colour'])
  const types = list(settings['filament_type'])
  const matrix = list(settings['flush_volumes_matrix']).map(Number)
  const n = colors.length
  if (n < 2 || matrix.length === 0 || matrix.length % (n * n) !== 0 || matrix.some((v) => !Number.isFinite(v))) return null
  // one multiplier per nozzle, as Bambu Studio writes it, or one for all
  const raw = settings['flush_multiplier']
  const values = (Array.isArray(raw) ? raw : [raw]).map(Number)
  const ok = values.length > 0 && values.every((v) => Number.isFinite(v) && v > 0)
  const multiplier: SettingValue = !ok ? 1 : Array.isArray(raw) ? (values as unknown as SettingValue) : values[0]!
  return { slots: colors.map((c, i) => ({ color: c.toLowerCase(), type: types[i] ?? '' })), n, matrix, multiplier }
}

/**
 * The file's matrix cut to the slots a slice uses, one block per nozzle, while those slots hold the filaments it was
 * saved for. Null once a slot's color or type changed, or when the file has another number of nozzles.
 */
export function keptFlush(f: ProjectFlush, slots: readonly { color: string; type: string }[], nozzles: number): number[] | null {
  if (slots.length > f.n || f.matrix.length !== nozzles * f.n * f.n) return null
  const same = slots.every((s, i) => s.color.toLowerCase() === f.slots[i]?.color && s.type === f.slots[i]?.type)
  if (!same) return null
  const k = slots.length
  const out: number[] = []
  for (let b = 0; b < nozzles; b++) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) out.push(f.matrix[b * f.n * f.n + i * f.n + j]!)
  return out
}

/** The tower's front left corner on the plate from the file's wipe_tower_x and wipe_tower_y (printer coordinates). */
export function projectTowerFrom(settings: Record<string, unknown>, origin: readonly [number, number]): { x: number; y: number } | null {
  const x = firstNumber(settings['wipe_tower_x'])
  const y = firstNumber(settings['wipe_tower_y'])
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round((x - origin[0]) * 10) / 10, y: Math.round((y - origin[1]) * 10) / 10 }
}

/** Keeps an opened project's flush volumes and tower spot. Returns the line for the open's note, or '' when the file has neither. */
export function keepProjectFlushAndTower(settings: Record<string, unknown>): string {
  const flush = projectFlushFrom(settings)
  const tower = projectTowerFrom(settings, areaOrigin(resolveConfig(get().easy, get().overrides)['printable_area']))
  set({ projectFlush: flush, towerFromProject: !!tower, ...(tower ? { tower: { auto: false, ...tower } } : {}) })
  const kept = [flush ? 'flush volumes' : '', tower ? 'prime tower position' : ''].filter(Boolean)
  return kept.length ? `Kept the project's ${kept.join(' and ')}.` : ''
}
