// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Thin layers and the cooling slowdown: the minimum layer time a material needs when sleipnir prints
// thin layers, and the heat creep warning for layers slowed to a trickle. src/thin_layers.rs does the same.
import type { MaterialKnowledge } from './knowledge'

/**
 * Heat creep warning threshold: a slowed layer that extrudes less than this share of the filament's
 * maximum volumetric speed. No maker publishes a threshold, so this is an expert rule and only ever warns. 3.5 percent sits between the 0.32 to
 * 0.64 mm3/s the research calls low (a 0.08 mm layer at the 10 to 20 mm/s minimum speed, 1.5 to 3
 * percent of a 21 mm3/s limit) and the 0.84 mm3/s of an ordinary 0.2 mm layer at 10 mm/s (4 percent).
 */
export const HEAT_CREEP_SHARE = 0.035

const r2 = (n: number): number => Math.round(n * 100) / 100
const r1 = (n: number): number => Math.round(n * 10) / 10

export interface HeatCreepInput {
  /** The slowest speed the cooling slowdown may reach, mm/s. */
  minSpeed: number
  /** Extrusion width, mm. */
  width: number
  /** The thinnest layer that will print, mm. */
  thinnest: number
  /** The filament's maximum volumetric speed, mm3/s. */
  maxFlow: number
}

/** The warning text when a slowed thin layer extrudes only a sliver of the filament's limit. */
export function heatCreepWarning(i: HeatCreepInput): string | undefined {
  if (!(i.minSpeed > 0) || !(i.width > 0) || !(i.thinnest > 0) || !(i.maxFlow > 0)) return undefined
  const flow = i.minSpeed * i.width * i.thinnest
  if (!(flow < i.maxFlow * HEAT_CREEP_SHARE)) return undefined
  return `Layers of ${i.thinnest} mm slowed to ${i.minSpeed} mm/s extrude only ${r2(flow)} mm3/s, ${r1((flow / i.maxFlow) * 100)} percent of the ${i.maxFlow} mm3/s filament limit. The filament can soften above the melt zone and clog (heat creep). Open the printer door or raise the minimum print speed. This is an expert rule, not a published limit.`
}

/** The minimum layer time thin layers need for this material, when the research has one. */
export function layerTimeGuard(material?: Pick<MaterialKnowledge, 'coolingGuard'>): { minLayerTime: number; note?: string; src: string[] } | undefined {
  return material?.coolingGuard
}
