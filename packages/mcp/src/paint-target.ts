// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PaintTarget } from '@slicerx/cad-history'
import { z } from 'zod'
import { ToolInputError } from './errors'

type V3 = [number, number, number]
const vec3 = z.tuple([z.number(), z.number(), z.number()])

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
    z.object({ kind: z.literal('replace'), from: z.number().int().min(0).max(255).describe('The state replaced by state') }),
  ])
  .describe('What to paint: { kind: "part" } | { kind: "direction", direction: "bottom" | ... | [x,y,z], angle_deg?, pick? } | { kind: "height", below | above | from and to (mm) } | { kind: "seed", point, angle_deg?, mode? } | { kind: "replace", from }')

type TargetIn = z.infer<typeof targetArg>

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

