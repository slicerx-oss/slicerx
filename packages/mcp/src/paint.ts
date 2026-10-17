// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Painting a design over MCP: a preview of what a target paints (nothing changes), then applying the preview as a
// paint step in the design's history, so it replays, saves and undoes the way the app's history does. Targets are
// in words a person uses (sx-geom paint.select): the part, faces facing a direction, a height band, a point grown
// into a region, or one state for another. Read-back gives each painted state's area and regions.
import { stepName, type HistoryMesh, type PaintLayer, type PaintTarget, type StepParams } from '@slicerx/cad-history'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { designArg, designSummary, type Design, type Designs } from './design'
import { faceAt } from './design-tools'
import { ToolInputError } from './models'
import { layerArg, targetArg, storedTarget } from './paint-target'

type V3 = [number, number, number]

interface Region {
  areaMm2: number
  triangles: number
  boundsMm: { min: V3; max: V3 }
}

interface Preview {
  id: string
  design: string
  /** The history the preview was made on: its length and last step. */
  steps: number
  last: string | undefined
  part: number
  params: Extract<StepParams, { op: 'paint' }>
  /** Each touched part's texts of the layer after the step. */
  expected: Record<number, Record<number, string>>
}

type Texts = Record<number, string>

/** The layer's texts of a part with `changed` written over them (an empty text clears a triangle). */
function merged(before: Texts | undefined, changed: Record<string, string>): Texts {
  const out: Texts = { ...(before ?? {}) }
  for (const [k, v] of Object.entries(changed)) {
    if (v) out[Number(k)] = v
    else delete out[Number(k)]
  }
  return out
}

const sameTexts = (a: Texts | undefined, b: Texts | undefined): boolean => {
  const ka = Object.keys(a ?? {})
  const kb = Object.keys(b ?? {})
  return ka.length === kb.length && ka.every((k) => (a ?? {})[Number(k)] === (b ?? {})[Number(k)])
}

/** The union of region boxes, for framing a picture. */
function boundsOf(regions: Region[]): { min: V3; max: V3 } | undefined {
  if (!regions.length) return undefined
  const min: V3 = [Infinity, Infinity, Infinity]
  const max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const r of regions)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, r.boundsMm.min[k]!)
      max[k] = Math.max(max[k]!, r.boundsMm.max[k]!)
    }
  return { min, max }
}

const meshOf = (p: HistoryMesh) => ({ positions: Array.from(p.positions), indices: Array.from(p.indices) })

export function paintTools(designs: Designs): PilotTool<never>[] {
  const engine = designs.deps.engine
  const previews = new Map<string, Preview>()
  let seq = 0

  /** A picture of the design with `layerPaint` drawn on its parts; the PNG only when asked. */
  async function picture(d: Design, layer: PaintLayer, layerPaint: (part: number) => Texts | undefined, view: string, focus: { min: V3; max: V3 } | undefined, size: number | undefined, image: boolean) {
    // The layer's states are drawn as filament colors (for color paint they are the filaments).
    void layer
    const objects = d.parts.map((p, i) => {
      const t = layerPaint(i)
      return { mesh: meshOf(p), transform: d.transform, slot: p.slot, ...(t && Object.keys(t).length ? { paint: t } : {}) }
    })
    const r = (await engine('render', { objects, view, ...(focus ? { focus } : {}), ...(size ? { size } : {}), image })) as Record<string, unknown>
    const png = typeof r['pngBase64'] === 'string' ? r['pngBase64'] : undefined
    const { pngBase64: _png, ...summary } = r
    return { summary, images: image && png ? [{ mime: 'image/png' as const, data: png }] : undefined }
  }

  const preview = defineTool({
    name: 'paint.preview',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'See what painting a design would do, without changing it: the triangles and area a target paints on each part, its connected regions, and a picture framed on them (the PNG only with image: true). Targets in words: the whole part, faces facing a direction ("the bottom" is direction bottom; "the top cap" is direction top with pick largest), a height band, a point grown into a region (smart fill or bucket), or one state for another. Show the person the preview, then apply it with slicerx_paint_apply and its preview id.',
    input: z.object({
      design: designArg,
      layer: layerArg,
      state: z.number().int().min(0).max(255).describe('For color the filament slot (1 is the first); 0 clears paint'),
      target: targetArg,
      part: z.number().int().min(0).optional().describe('Paint one part, from 0; absent: every part (a seed paints the part under its point)'),
      max_depth: z.number().int().min(0).max(10).optional().describe('How finely a height band splits triangles at its edges; 6 when left out'),
      view: z.enum(['fit', 'iso', 'top', 'front']).default('fit'),
      size: z.number().int().min(64).max(2048).optional(),
      image: z.boolean().default(false),
    }),
    async run(i) {
      const d = designs.get(i.design)
      let target = storedTarget(i.target)
      let part = i.part ?? -1
      if (target.kind === 'seed') {
        // The seed's face, kept by its key as push steps keep theirs, and the part it is on.
        const at = faceAt(d, target.point)
        part = at.part
        target = { ...target, ...(at.key ? { faceKey: at.key } : {}) }
      }
      if (part >= d.parts.length) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
      const parts = part === -1 ? d.parts.map((_, k) => k) : [part]
      const params: Extract<StepParams, { op: 'paint' }> = { op: 'paint', layer: i.layer, state: i.state, target, ...(i.max_depth !== undefined ? { maxDepth: i.max_depth } : {}) }
      const expected: Record<number, Texts> = {}
      const rows: { part: number; changedTriangles: number; selectedAreaMm2: number; regionCount: number; regions: Region[] }[] = []
      for (const k of parts) {
        const p = d.parts[k]!
        const before = p.paint?.[i.layer]
        const { faceKey: _key, ...asked } = target as PaintTarget & { faceKey?: number }
        const r = (await engine('paint.select', { mesh: meshOf(p), transform: d.transform, paint: before ?? {}, state: i.state, target: asked, ...(i.max_depth !== undefined ? { maxDepth: i.max_depth } : {}) })) as { changed: Record<string, string>; changedTriangles: number; selectedAreaMm2: number; regionCount: number; regions: Region[] }
        expected[k] = merged(before, r.changed)
        if (r.changedTriangles || r.selectedAreaMm2) rows.push({ part: k, changedTriangles: r.changedTriangles, selectedAreaMm2: r.selectedAreaMm2, regionCount: r.regionCount, regions: r.regions })
      }
      if (!rows.some((r) => r.changedTriangles)) throw new ToolInputError('The target paints nothing new on this design; try another target, part or state.')
      const id = `p${++seq}`
      previews.set(id, { id, design: d.id, steps: d.history.steps.length, last: d.history.steps.at(-1)?.id, part, params, expected })
      if (previews.size > 32) previews.delete(previews.keys().next().value!)
      const focus = boundsOf(rows.flatMap((r) => r.regions))
      const pic = await picture(d, i.layer, (k) => expected[k] ?? d.parts[k]?.paint?.[i.layer], i.view, i.view === 'fit' ? focus : undefined, i.size, i.image)
      const area = Math.round(rows.reduce((a, r) => a + r.selectedAreaMm2, 0) * 100) / 100
      return {
        summary: `Preview ${id}: ${stepName({ params })}, ${area} mm2 on ${rows.length} part${rows.length === 1 ? '' : 's'}. Apply with slicerx_paint_apply.`,
        output: { preview: id, step: stepName({ params }), areaMm2: area, parts: rows, picture: pic.summary },
        ...(pic.images ? { images: pic.images } : {}),
      }
    },
  })

  const apply = defineTool({
    name: 'paint.apply',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: "Apply a paint preview as a step in the design's history (it replays, saves with slicerx_design_save and undoes with slicerx_design_undo). Refused when the design changed since the preview; preview again then. Returns the paint read back, which matches the preview.",
    input: z.object({ preview: z.string().min(1).describe('The preview id from slicerx_paint_preview') }),
    async run(i) {
      const pv = previews.get(i.preview)
      if (!pv) throw new ToolInputError(`preview: no preview ${i.preview}; make one with slicerx_paint_preview`)
      const d = designs.get(pv.design)
      if (d.history.steps.length !== pv.steps || d.history.steps.at(-1)?.id !== pv.last) throw new ToolInputError('The design changed since this preview; preview again.')
      const s = await designs.add(d, pv.part, pv.params)
      previews.delete(pv.id)
      // What replay painted is what the preview showed.
      const off = Object.entries(pv.expected).filter(([k, t]) => !sameTexts(d.parts[Number(k)]?.paint?.[pv.params.layer], t)).map(([k]) => Number(k))
      const read = await regions(d, pv.params.layer)
      return {
        ok: off.length === 0,
        summary: off.length ? `Applied ${stepName(s)}, but parts ${off.join(', ')} read back other paint than the preview` : `Applied ${stepName(s)} as step ${d.history.steps.length}`,
        output: { step: { index: d.history.steps.length, id: s.id, name: stepName(s) }, paint: read, design: designSummary(d) },
      }
    },
  })

  async function regions(d: Design, layer: PaintLayer) {
    const out: { part: number; states: { state: number; areaMm2: number; triangles: number; regionCount: number; regions: Region[] }[] }[] = []
    for (const [k, p] of d.parts.entries()) {
      const texts = p.paint?.[layer]
      if (!texts || !Object.keys(texts).length) continue
      const r = (await engine('paint.regions', { mesh: meshOf(p), transform: d.transform, paint: texts })) as { states: { state: number; areaMm2: number; triangles: number; regionCount: number; regions: Region[] }[] }
      out.push({ part: k, states: r.states })
    }
    return out
  }

  const read = defineTool({
    name: 'paint.regions',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Read a design\'s paint back: for one layer, each part\'s painted states (for color, filament slots) with their area in mm2, triangles and connected regions with bounds. Optionally a picture (PNG only with image: true).',
    input: z.object({ design: designArg, layer: layerArg, image: z.boolean().default(false), view: z.enum(['fit', 'iso', 'top', 'front']).default('fit'), size: z.number().int().min(64).max(2048).optional() }),
    async run(i) {
      const d = designs.get(i.design)
      const out = await regions(d, i.layer)
      const totals: Record<string, number> = {}
      for (const p of out) for (const s of p.states) totals[s.state] = Math.round(((totals[s.state] ?? 0) + s.areaMm2) * 100) / 100
      const pic = await picture(d, i.layer, (k) => d.parts[k]?.paint?.[i.layer], i.view, undefined, i.size, i.image)
      const text = Object.keys(totals).length ? Object.entries(totals).map(([s, a]) => `state ${s} ${a} mm2`).join(', ') : 'nothing painted'
      return { summary: `${d.name} ${i.layer} paint: ${text}`, output: { layer: i.layer, totalsMm2: totals, parts: out, picture: pic.summary }, ...(pic.images ? { images: pic.images } : {}) }
    },
  })

  return [preview, apply, read] as PilotTool<never>[]
}
