// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Replaces "automatic" values (0 on keys flagged `auto` in the schema) with concrete ones, so an
// engine that does not know the convention can slice the config. src/auto.rs does the same.
import type { PrintConfig, SettingValue } from '@slicerx/contracts/settings'
import { numberOf } from './config'
import { SETTINGS } from './schema'

/** Line width as a multiple of the nozzle diameter when nothing else says. */
export const AUTO_WIDTH_RATIO: Readonly<Record<string, number>> = {
  line_width: 1.05,
  outer_wall_line_width: 1.05,
  inner_wall_line_width: 1.05,
  top_surface_line_width: 1.05,
  initial_layer_line_width: 1.2,
  sparse_infill_line_width: 1.125,
  internal_solid_infill_line_width: 1.125,
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4

function isZero(v: SettingValue | undefined): boolean {
  const one = (x: unknown): boolean => x === 0 || (typeof x === 'string' && x.trim() !== '' && Number(x) === 0)
  return Array.isArray(v) ? v.length > 0 && (v as unknown[]).every(one) : one(v)
}

/**
 * A copy of `config` with every `auto` key that is 0 replaced by a concrete value. Line widths come
 * from the nozzle diameter (1.05x for line width, walls and top surface, 1.2x for the first layer,
 * 1.125x for infill); when the default `line_width` is set, the other automatic widths take it, as
 * Orca does. `filament_ironing_speed` takes the process ironing speed. Keys the config does not
 * have are left alone. The nozzle is `opts.nozzleDiameter`, else the config's first nozzle, else 0.4 mm.
 */
export function resolveAuto(config: PrintConfig, opts: { nozzleDiameter?: number } = {}): PrintConfig {
  const nozzle = opts.nozzleDiameter ?? numberOf(config, 'nozzle_diameter', false) ?? 0.4
  const out: PrintConfig = { ...config }
  const lwRaw = config['line_width']
  let lineWidth = round4(nozzle * (AUTO_WIDTH_RATIO['line_width'] as number))
  if (lwRaw !== undefined && !isZero(lwRaw)) {
    const v = Array.isArray(lwRaw) ? lwRaw[0] : lwRaw
    if (typeof v === 'string' && v.endsWith('%')) lineWidth = round4((Number(v.slice(0, -1)) / 100) * nozzle)
    else if (Number.isFinite(Number(v))) lineWidth = Number(v)
  }
  const explicitLineWidth = lwRaw !== undefined && !isZero(lwRaw)
  for (const def of SETTINGS) {
    if (!def.auto) continue
    const cur = config[def.key]
    if (cur === undefined || !isZero(cur)) continue
    let value: number
    if (def.key === 'filament_ironing_speed') value = numberOf(config, 'ironing_speed') ?? 20
    else if (def.key === 'line_width') value = lineWidth
    else if (explicitLineWidth) value = lineWidth
    else value = round4(nozzle * (AUTO_WIDTH_RATIO[def.key] ?? 1.05))
    const text = def.type === 'floatOrPercent' || def.type === 'floatsOrPercents' ? String(value) : value
    out[def.key] = (Array.isArray(cur) ? (cur as unknown[]).map(() => text) : text) as SettingValue
  }
  return out
}
