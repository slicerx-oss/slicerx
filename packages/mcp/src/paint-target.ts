// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PaintTarget } from '@slicerx/cad-history'
import { PAINT_FILAMENT_MAX } from '@slicerx/contracts'
import { z } from 'zod'
import { ToolInputError } from './errors'

type V3 = [number, number, number]
const vec3 = z.tuple([z.number(), z.number(), z.number()])

/** Why a paint state above 32 is refused: paint names the filaments a project holds, 1 to 32. */
export const PAINT_STATE_REFUSAL = `Paint uses filaments 1 to ${PAINT_FILAMENT_MAX}, as many as a project holds.`

/** A paint state: for color the filament (1 to 32), seam and support 1 or 2, fuzzy 1; 0 clears. */
export const paintState = () => z.number().int().min(0).max(PAINT_FILAMENT_MAX, PAINT_STATE_REFUSAL)

export const layerArg = z.enum(['color', 'seam', 'support', 'fuzzy']).default('color').describe('Paint layer: color (state = filament slot), seam (1 seam here, 2 keep it away), support (1 enforcer, 2 blocker) or fuzzy (1 fuzzy skin)')

export const targetArg = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('part') }),
    z.object({
      kind: z.literal('direction'),
      direction: z.union([z.enum(['bottom', 'top', 'front', 'back', 'left', 'right']), vec3]),
      angle_deg: z.number().min(0).max(180).optional().describe('Faces within this angle of the direction; 30 when left out'),
      pick: z.union([z.enum(['all', 'largest']), z.object({ nearest: vec3 })]).optional().describe('Which connected region: all (default), the largest, or the one nearest a point'),
    }),
    z.object({ kind: z.literal('height'), below: z.number().optional(), above: z.number().optional(), from: z.number().optional(), to: z.number().optional() }),
    z.object({
      kind: z.literal('seed'),
      point: vec3.describe('A point on the surface, mm, world (the design frame)'),
      angle_deg: z.number().min(0).max(180).optional().describe('Smart fill crosses edges that bend less than this; 30 when left out'),
      mode: z.enum(['smart', 'bucket']).optional().describe('smart (default): across gentle edges; bucket: over the triangles of the seed state'),
    }),
    z.object({ kind: z.literal('replace'), from: paintState().describe('The state replaced by state') }),
  ])
  .describe('What to paint: { kind: "part" } | { kind: "direction", direction: "bottom" | ... | [x,y,z], angle_deg?, pick? } | { kind: "height", below | above | from and to (mm) } | { kind: "seed", point, angle_deg?, mode? } | { kind: "replace", from }')

type TargetIn = z.infer<typeof targetArg>

/** A part's triangles, as the design history and the app's plate both keep them. */
type BandMesh = { positions: ArrayLike<number>; indices: ArrayLike<number> }

/** How close a height band's edge comes to its height, mm: under half the finest layer, so a band starts and ends on its layers. */
export const BAND_EDGE_MM = 0.04
/** The depths a height band splits triangles to when none is given: never coarser than before, at most the engine's. */
const BAND_DEPTH = { min: 6, max: 10 }

/**
 * How finely a height band splits the parts' triangles at its edges, when the caller gives no depth: each level halves
 * a triangle's height, so the tallest triangle splits until its pieces are BAND_EDGE_MM tall. A hull side one
 * triangle tall (14 mm) at depth 6 put the edge up to 0.22 mm off, a whole extra layer of the band's color. The server's
 * paint.preview and the app link's both pick it, so a band lands on the same layers through either.
 */
export function bandDepth(parts: readonly BandMesh[], transform: readonly number[]): number {
  let tallest = 0
  const z = (p: BandMesh, v: number) => transform[2]! * p.positions[v * 3]! + transform[6]! * p.positions[v * 3 + 1]! + transform[10]! * p.positions[v * 3 + 2]! + transform[14]!
  for (const p of parts)
    for (let t = 0; t + 2 < p.indices.length; t += 3) {
      const a = z(p, p.indices[t]!), b = z(p, p.indices[t + 1]!), c = z(p, p.indices[t + 2]!)
      tallest = Math.max(tallest, Math.max(a, b, c) - Math.min(a, b, c))
    }
  const depth = tallest > 0 ? Math.ceil(Math.log2(tallest / BAND_EDGE_MM)) : BAND_DEPTH.min
  return Math.min(BAND_DEPTH.max, Math.max(BAND_DEPTH.min, depth))
}

/** The stored target of a tool's input: camelCase, as cad-history and sx-geom read it. */
export function storedTarget(t: TargetIn): PaintTarget {
  switch (t.kind) {
    case 'part':
      return { kind: 'part' }
    case 'direction':
      return { kind: 'direction', direction: t.direction as V3 | 'bottom', ...(t.angle_deg !== undefined ? { angleDeg: t.angle_deg } : {}), ...(t.pick ? { pick: t.pick as 'all' | 'largest' | { nearest: V3 } } : {}) }
    case 'height': {
      const set = ['below', 'above', 'from', 'to'].filter((k) => t[k as 'below'] !== undefined).sort().join(',')
      if (!['below', 'above', 'from,to'].includes(set)) throw new ToolInputError('target: a height band takes below, above, or from and to (mm)')
      return { kind: 'height', ...(t.below !== undefined ? { below: t.below } : {}), ...(t.above !== undefined ? { above: t.above } : {}), ...(t.from !== undefined ? { from: t.from } : {}), ...(t.to !== undefined ? { to: t.to } : {}) }
    }
    case 'seed':
      return { kind: 'seed', point: t.point as V3, ...(t.angle_deg !== undefined ? { angleDeg: t.angle_deg } : {}), ...(t.mode ? { mode: t.mode } : {}) }
    case 'replace':
      return { kind: 'replace', from: t.from }
  }
}

