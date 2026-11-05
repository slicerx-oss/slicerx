// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A picture of a design's parts, whole or exploded: the same spread the app's Spread control draws (0 to 100 percent,
// radial or along a bed axis, @slicerx/contracts/explode), so a client can show how an assembly goes together. It moves
// the parts in the picture only; the design, its steps and its saved file stay as they are.
import { point, type HistoryMesh, type Mat4 } from '@slicerx/cad-history'
import { EXPLODE_AXES, explodeOffsets, type PartBox, type Vec3 } from '@slicerx/contracts/explode'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { designArg, type Design, type Designs } from './design'

/** A part's box in bed coordinates, mm: its vertices through the design's transform. */
export function partBox(p: HistoryMesh, t: Mat4): PartBox {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < p.positions.length; i += 3) {
    const v = point(t, p.positions, i)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, v[k]!)
      max[k] = Math.max(max[k]!, v[k]!)
    }
  }
  return { min, max }
}

/** The design's transform with `o` (bed mm) added to its move: the part drawn moved, turned and scaled as before. */
const moved = (t: Mat4, o: Vec3): Mat4 => t.map((v, i) => (i === 12 ? v + o[0] : i === 13 ? v + o[1] : i === 14 ? v + o[2] : v))

const round = (v: number) => Math.round(v * 100) / 100

export function designRenderTools(designs: Designs): PilotTool<never>[] {
  const engine = designs.deps.engine

  const render = defineTool({
    name: 'design.render',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      "Draw a design's parts to check them: a small orthographic picture (384 px on the long side unless size says otherwise), each part in its filament color. With spread (0 to 100 percent) the parts are drawn moved apart, an exploded view as the app's Spread control draws it: radial moves each part out from the middle of the design, x and y spread them along that bed axis in their order, z keeps the lowest part and lifts the others above it. Returns what is in view and offsetsMm, how far each part was moved (bed mm, part 0 first); the PNG comes with the reply only when image is true. Nothing is changed: the design, its steps and its saved file keep every part where it is.",
    input: z.object({
      design: designArg,
      spread: z.number().min(0).max(100).default(0).describe('How far apart the parts are drawn, 0 to 100 percent; 0 draws the design whole'),
      axis: z.enum(EXPLODE_AXES as unknown as ['radial', 'x', 'y', 'z']).default('radial').describe('radial: out from the middle; x, y: along that bed axis in order; z: the lowest part stays and the others rise'),
      view: z.enum(['iso', 'top', 'front', 'fit']).default('iso'),
      size: z.number().int().min(64).max(2048).optional().describe('Long side of the picture in px; 384 when left out'),
      image: z.boolean().default(false).describe('Return the PNG with the reply. Leave false to get only the text summary'),
      colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(32).optional().describe('Filament colors by slot, slot 1 first, as #rrggbb'),
    }),
    async run(i) {
      const d: Design = designs.get(i.design)
      const offsets = explodeOffsets(d.parts.map((p) => partBox(p, d.transform)), i.spread, i.axis)
      const objects = d.parts.map((p, k) => ({ mesh: { positions: Array.from(p.positions), indices: Array.from(p.indices) }, transform: moved(d.transform, offsets[k]!), slot: p.slot }))
      const r = (await engine('render', { objects, view: i.view, ...(i.size !== undefined ? { size: i.size } : {}), ...(i.colors ? { colors: i.colors } : {}), image: i.image })) as Record<string, unknown>
      const png = typeof r['pngBase64'] === 'string' ? r['pngBase64'] : undefined
      const { pngBase64: _png, ...summary } = r
      const images = i.image && png ? [{ mime: 'image/png' as const, data: png }] : undefined
      const parts = d.parts.length
      const spread = parts > 1 && i.spread > 0 ? `, spread ${i.spread} percent ${i.axis === 'radial' ? 'radially' : `along ${i.axis.toUpperCase()}`}` : ''
      return {
        summary: `Drew ${d.name} (${parts} ${parts === 1 ? 'part' : 'parts'}) from the ${i.view} view${spread}${images ? '' : ' (summary only; pass image: true for the picture)'}`,
        output: { ...summary, spread: parts > 1 ? i.spread : 0, axis: i.axis, offsetsMm: offsets.map((o) => o.map(round)) },
        ...(images ? { images } : {}),
      }
    },
  })

  return [render] as PilotTool<never>[]
}
