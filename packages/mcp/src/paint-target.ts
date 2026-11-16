// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { featureKey, featureNames, type PaintTarget, type Step } from '@slicerx/cad-history'
import { PAINT_FILAMENT_MAX } from '@slicerx/contracts'
import { z } from 'zod'
import { ToolInputError } from './errors'

type V3 = [number, number, number]
const vec3 = z.tuple([z.number(), z.number(), z.number()])

/** Why a paint state above 32 is refused: paint names the filaments a project holds, 1 to 32. */
export const PAINT_STATE_REFUSAL = `Paint uses filaments 1 to ${PAINT_FILAMENT_MAX}, as many as a project holds.`

/** A paint state: for color the filament (1 to 32), seam and support 1 or 2, fuzzy 1; 0 clears. */
export const paintState = () => z.number().int().min(0).max(PAINT_FILAMENT_MAX, PAINT_STATE_REFUSAL)

/** Where a band that stands for a real feature goes: at that feature's real height, as the plan's colors and the paint target say. */
export const REAL_BAND_TEXT =
  "A band that stands for a real feature (a stripe, a trim line, the line where one paint meets another) sits at that feature's real height scaled to the model, looked up first when it isn't known; never a thin token band in its place."

/** What a paint target can be, as the paint tools describe their target. */
export const PAINT_TARGET_TEXT = `What to paint: { kind: "part" } | { kind: "direction", direction: "bottom" | ... | [x,y,z], angle_deg?, pick? } | { kind: "height", below | above | from and to (mm) } | { kind: "seed", point, angle_deg?, mode? } | { kind: "replace", from } | { kind: "feature", feature }: every face the steps of that plan feature made, such as a roof, a handle, a pole, a chimney top or a trim, even on a body built from many steps. ${REAL_BAND_TEXT}`

/**
 * Why a paint by feature is refused when the design has no feature by that name: the names it has, as a plan amend
 * names the features it can change.
 */
/** The refusal of a feature target on a part that is not an exact solid, whose faces no longer say which step made them. */
export const featureNotExactText = (part: number): string => `target: painting by feature needs a part built as an exact solid, and part ${part} is not one; paint it by height, by direction or from a seed point instead`

/** The first of `parts` that is built as a mesh (`meshed`), whose faces a feature target cannot be read from, or undefined. */
export const meshedOf = (parts: readonly number[], meshed: readonly number[]): number | undefined => parts.find((k) => meshed.includes(k))

export const noFeatureText = (feature: string, names: readonly string[]): string => (names.length ? `target: ${feature} is not a planned feature; name one the plan has (${names.join(', ')})` : `target: ${feature} is not a planned feature`)

/**
 * A paint by feature's feature as the design's steps name it (case and spacing aside), or the refusal listing the names
 * it has. Paint steps tagged with a feature make no faces, so their names are not offered.
 */
export function plannedFeature(steps: readonly Pick<Step, 'feature' | 'params'>[], feature: string): string {
  const names = featureNames(steps.filter((s) => s.params.op !== 'paint'))
  const hit = names.find((n) => featureKey(n) === featureKey(feature))
  if (!hit) throw new ToolInputError(noFeatureText(feature.trim(), names))
  return hit
}

export const layerArg = z.enum(['color', 'seam', 'support', 'fuzzy']).default('color').describe('Paint layer: color (state = filament slot), seam (1 seam here, 2 keep it away), support (1 enforcer, 2 blocker) or fuzzy (1 fuzzy skin)')

/** The targets every form takes: what a part, a direction, a height, a seed or a filament picks. */
const BASE_TARGETS = [
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
] as const

export const targetArg = z
  .discriminatedUnion('kind', [...BASE_TARGETS, z.object({ kind: z.literal('feature'), feature: z.string().min(1).max(200) })])
  .describe(PAINT_TARGET_TEXT)

/**
 * The target a local model's paint.preview takes: every kind but a feature, as before it, since its row has no room
 * for the feature's words (packages/pilot/src/local-tools.ts).
 */
export const LOCAL_PAINT_TARGET_TEXT = 'What to paint: { kind: "part" } | { kind: "direction", direction: "bottom" | ... | [x,y,z], angle_deg?, pick? } | { kind: "height", below | above | from and to (mm) } | { kind: "seed", point, angle_deg?, mode? } | { kind: "replace", from }'
export const localTargetArg = z.discriminatedUnion('kind', [...BASE_TARGETS]).describe(LOCAL_PAINT_TARGET_TEXT)

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
    case 'feature':
      return { kind: 'feature', feature: t.feature.trim() }
  }
}

