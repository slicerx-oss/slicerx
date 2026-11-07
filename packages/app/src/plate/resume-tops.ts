// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The layer tops a resume plans with: the failed job's own layers when the app still has them, else the layers the
// resumed slice will print. A plate with its own layer heights prints at its own tops, which the engine stretches by a
// filament's Z shrinkage compensation, so the plan counts layers in those, not in even layers of layer_height.
import { effectiveSlot, mapSlot } from '../filament/slots'
import { plateSliceConfig } from '../state/slice-plate'
import type { AppState } from '../state/store'
import { plateProfileTops } from './layer-profile'
import { activeMeta } from './plates'

/** The failed job's layers: a resume plan's stored tops, else the last slice's layers while it is still current. */
export function jobLayerTops(s: Pick<AppState, 'resume' | 'slice'>): number[] | undefined {
  if (s.resume?.layerTopsMm?.length) return s.resume.layerTopsMm
  if (s.slice.status !== 'done') return undefined
  const z = (s.slice.result as { layerZ?: ArrayLike<number> }).layerZ
  return z && z.length ? Array.from(z) : undefined
}

/** A filament percentage for a slot from an array or a single value ("99.5%" or 99.5), 100 when unset. */
function percentFor(v: unknown, slot: number): number {
  const at = Array.isArray(v) ? (v[slot - 1] ?? v[v.length - 1]) : v
  const n = typeof at === 'number' ? at : Number(String(at ?? '').trim().replace(/%$/, ''))
  return Number.isFinite(n) && n > 0 ? n : 100
}

/**
 * The Z scale a filament shrinkage compensation gives the plate, as the engine applies it: 100 over
 * filament_shrinkage_compensation_z when every slot the plate prints with has the same filament_shrink and Z value,
 * else 1 (no compensation).
 */
export function zShrinkFactor(config: Readonly<Record<string, unknown>>, slots: Iterable<number>): number {
  const values = [...new Set(slots)].map((slot) => [percentFor(config['filament_shrink'], slot), percentFor(config['filament_shrinkage_compensation_z'], slot)] as const)
  if (!values.length || values.some(([xy, z]) => xy !== values[0]![0] || z !== values[0]![1])) return 1
  const z = values[0]![1]
  return Math.abs(z - 100) < 1e-9 ? 1 : 100 / Math.max(1, z)
}

/** Tops stretched as the engine stretches exact tops by `fz`: the first layer as it is, the rest evenly, the last on last x fz. */
export function stretchTops(tops: readonly number[], fz: number): number[] {
  const first = tops[0]
  const last = tops[tops.length - 1]
  if (first === undefined || last === undefined || tops.length < 2 || last <= first || Math.abs(fz - 1) < 1e-12) return [...tops]
  const k = (last * fz - first) / (last - first)
  return tops.map((t) => first + (t - first) * k)
}

/**
 * The tops a resume plans with. The job's own layers when the app has them (jobLayerTops). Without them (the slice is
 * not current: a reopened project, a resume from the fleet), the tops the resumed slice will print: the plate's own
 * layer heights, stretched by its Z shrinkage as the engine stretches them. Undefined for a plate without its own, which
 * prints even layers. These are for the plan only: the slice sends the plate's own tops unstretched, as the job did.
 */
export function resumePlanTops(s: AppState): number[] | undefined {
  const job = jobLayerTops(s)
  if (job) return job
  const meta = activeMeta(s)
  const profile = meta?.settings.layerProfile
  if (!profile?.length || s.calibration[s.activePlate]) return undefined
  const entries = s.plate.filter((p) => p.printable !== false)
  const config = plateSliceConfig(s, meta)
  const tops = plateProfileTops(profile, entries, config)
  if (!tops) return undefined
  const slots = entries.flatMap((o) => o.handle.parts.map((part) => mapSlot(meta, effectiveSlot(o, part))))
  return stretchTops(tops, zShrinkFactor(config, slots.length ? slots : [1]))
}
