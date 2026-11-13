// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Painting a design over MCP: a preview of what a target paints (nothing changes), then applying the preview as a
// paint step in the design's history, so it replays, saves and undoes the way the app's history does. Targets are
// in words a person uses (sx-geom paint.select): the part, faces facing a direction, a height band, a point grown
// into a region, or one state for another. Read-back gives each painted state's area and regions.
import { stepName, type DesignHost, type HistoryMesh, type PaintLayer, type PaintTarget, type StepParams } from '@slicerx/cad-history'
import { defineTool, type PilotTool, type ToolContext } from '@slicerx/pilot'
import { z } from 'zod'
import { designArg, designSummary, faceAt, featureArg, withFeature, type Design } from './design-tools'
import { ToolInputError } from './errors'
import { bandDepth, layerArg, paintState, targetArg, storedTarget } from './paint-target'

export { BAND_EDGE_MM, bandDepth } from './paint-target'

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
  /** The plan feature the paint builds, when the preview was given one; paint.apply tags the step with it. */
  feature?: string | undefined
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

/**
 * The paint tools on any design host: the server's own designs, or the app's plate, where the mimir tab paints. They
 * need only what every host has: its designs, a step added to one, and its geometry engine.
 */
const r1 = (n: number): number => Math.round(n * 10) / 10

/**
 * The band a person means, picked on a one-tap question: each band painted on the part by height (named by its plan
 * feature when it has one), the part outside a single band, and the whole part. Null when the part has no band by
 * height to offer.
 */
async function pickBand(d: Design, part: number, state: number, ask: NonNullable<ToolContext['ask']>): Promise<{ target: PaintTarget; label: string } | null> {
  type Height = Extract<PaintTarget, { kind: 'height' }>
  const bands = d.history.steps.flatMap((s, k) => (s.part === part && !s.suppressed && (!d.status[k] || d.status[k]!.state === 'done') && s.params.op === 'paint' && s.params.layer === 'color' && s.params.target.kind === 'height' ? [{ t: s.params.target as Height, feature: s.feature }] : []))
  if (!bands.length) return null
  const words = (t: Height): string => (t.below !== undefined ? `Below ${r1(t.below)} mm` : t.above !== undefined ? `Above ${r1(t.above)} mm` : `From ${r1(t.from ?? 0)} to ${r1(t.to ?? 0)} mm`)
  const choices: { label: string; target: PaintTarget }[] = []
  for (const b of bands) {
    const label = b.feature ? `${b.feature} (${words(b.t).toLowerCase()})` : words(b.t)
    if (!choices.some((c) => JSON.stringify(c.target) === JSON.stringify(b.t))) choices.push({ label, target: b.t })
  }
  // the rest of the part, when one band has one edge
  const one = bands.length === 1 ? bands[0]!.t : null
  if (one && one.below !== undefined && one.above === undefined) choices.push({ label: `Above ${r1(one.below)} mm`, target: { kind: 'height', above: one.below } })
  if (one && one.above !== undefined && one.below === undefined) choices.push({ label: `Below ${r1(one.above)} mm`, target: { kind: 'height', below: one.above } })
  choices.push({ label: 'All of it', target: { kind: 'part' } })
  const name = d.parts[part]!.name
  const picked = await ask({ title: 'Paint', question: `Paint which part of ${name} in filament ${state}?`, choices: choices.map((c, k) => ({ id: `band:${k}`, label: c.label })) })
  const at = Number(picked.id.replace(/^band:/, ''))
  const c = choices[at]
  return c ? { target: c.target, label: c.label } : null
}

export function paintTools(designs: DesignHost): PilotTool<never>[] {
  const engine = (op: string, request: unknown) => designs.call(op, request)
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

  const previewInput = z.object({
    design: designArg,
    layer: layerArg,
    state: paintState().describe('For color the filament slot, 1 to 32 (1 is the first); 0 clears paint'),
    target: targetArg,
    part: z.number().int().min(0).optional().describe('Paint one part, from 0; absent: every part (a seed paints the part under its point)'),
    max_depth: z.number().int().min(0).max(10).optional().describe('How many times a height band halves triangles at its edges; left out, edges land within 0.04 mm of the height (6 to 10)'),
    view: z.enum(['fit', 'iso', 'top', 'front']).default('fit'),
    size: z.number().int().min(64).max(2048).optional(),
    image: z.boolean().default(false),
    feature: featureArg,
    whole: z.boolean().optional().describe('With target part on a part already painted in bands: true when the person said the whole part ("the whole body", "all of it"); without it the person picks the band on a one-tap question'),
  })
  const preview = defineTool({
    name: 'paint.preview',
    version: '1.4.0',
    source: 'command',
    permission: 'read',
    description:
      'See what painting a design would do, without changing it: the triangles, area and connected regions a target paints on each part, and a picture framed on them (the PNG only with image: true). Targets in words: the whole part, faces facing a direction ("the bottom" is direction bottom; "the top cap" is direction top with pick largest), a height band, a point grown into a region (smart fill or bucket), or one state for another. Show the person the preview, then apply it with slicerx_paint_apply and its preview id.',
    input: previewInput,
    // a local model's form leaves out whole, which only the cloud follow-up guidance asks for
    localInput: previewInput.omit({ whole: true }),
    async run(i, ctx) {
      const d = designs.get(i.design)
      let target = storedTarget(i.target)
      let took = ''
      let part = i.part ?? -1
      if (target.kind === 'seed') {
        // The seed's face, kept by its key as push steps keep theirs, and the part it is on.
        const at = faceAt(d, target.point)
        part = at.part
        target = { ...target, ...(at.key ? { faceKey: at.key } : {}) }
      }
      if (part >= d.parts.length) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
      const parts = part === -1 ? d.parts.map((_, k) => k) : [part]
      // a color asked for on a part already painted in bands goes on one band, the one the person most likely means
      if (i.layer === 'color' && target.kind === 'part' && !i.whole) {
        // a part with any band: a state of its own, or the asked color over part of it (the rest its own filament)
        const banded = (await regions(d, 'color')).filter((r) => parts.includes(r.part) && r.states.some((s) => s.state !== i.state || s.triangles < d.parts[r.part]!.indices.length / 3))
        // one part with bands painted by height: the person picks the band on a one-tap question
        const picked = banded.length === 1 && parts.length === 1 && ctx?.ask ? await pickBand(d, parts[0]!, i.state, ctx.ask) : null
        if (picked) {
          target = picked.target
          took = picked.label
        } else if (banded.length) {
          const said = banded.map((r) => {
            const bands = r.states.map((s) => `filament ${s.state} over ${Math.round(s.areaMm2)} mm2`)
            return `${d.parts[r.part]!.name} is painted in bands: ${bands.join(', ')}, and the rest in its own filament`
          })
          throw new ToolInputError(`target: ${said.join('; ')}. Painting the whole part would cover every band: paint the band the person most likely means with a height target (below the band line, such as {"kind":"height","below":4}) and say which band you took; if two bands fit equally, ask with two choices`)
        }
      }
      // a height band's edge lands on its height (the step keeps the depth, so a replay paints the same)
      const maxDepth = i.max_depth ?? (target.kind === 'height' ? bandDepth(parts.map((k) => d.parts[k]!), d.transform) : undefined)
      const params: Extract<StepParams, { op: 'paint' }> = { op: 'paint', layer: i.layer, state: i.state, target, ...(maxDepth !== undefined ? { maxDepth } : {}) }
      const expected: Record<number, Texts> = {}
      const rows: { part: number; changedTriangles: number; selectedAreaMm2: number; regionCount: number; regions: Region[] }[] = []
      for (const k of parts) {
        const p = d.parts[k]!
        const before = p.paint?.[i.layer]
        const { faceKey: _key, ...asked } = target as PaintTarget & { faceKey?: number }
        const r = (await engine('paint.select', { mesh: meshOf(p), transform: d.transform, paint: before ?? {}, state: i.state, target: asked, ...(maxDepth !== undefined ? { maxDepth } : {}) })) as { changed: Record<string, string>; changedTriangles: number; selectedAreaMm2: number; regionCount: number; regions: Region[] }
        expected[k] = merged(before, r.changed)
        if (r.changedTriangles || r.selectedAreaMm2) rows.push({ part: k, changedTriangles: r.changedTriangles, selectedAreaMm2: r.selectedAreaMm2, regionCount: r.regionCount, regions: r.regions })
      }
      if (!rows.some((r) => r.changedTriangles)) throw new ToolInputError('The target paints nothing new on this design; try another target, part or state.')
      const id = `p${++seq}`
      previews.set(id, { id, design: d.id, steps: d.history.steps.length, last: d.history.steps.at(-1)?.id, part, params, expected, feature: i.feature })
      if (previews.size > 32) previews.delete(previews.keys().next().value!)
      const focus = boundsOf(rows.flatMap((r) => r.regions))
      const pic = await picture(d, i.layer, (k) => expected[k] ?? d.parts[k]?.paint?.[i.layer], i.view, i.view === 'fit' ? focus : undefined, i.size, i.image)
      const area = Math.round(rows.reduce((a, r) => a + r.selectedAreaMm2, 0) * 100) / 100
      return {
        summary: `${took ? `The person picked ${took.toLowerCase()}. ` : ''}Preview ${id}: ${stepName({ params })}, ${area} mm2 on ${rows.length} part${rows.length === 1 ? '' : 's'}. Apply with slicerx_paint_apply.`,
        output: { preview: id, step: stepName({ params }), areaMm2: area, parts: rows, picture: pic.summary },
        ...(pic.images ? { images: pic.images } : {}),
      }
    },
  })

  const apply = defineTool({
    name: 'paint.apply',
    version: '1.3.0',
    source: 'command',
    permission: 'slice',
    description: "Apply a paint preview as a design step (it replays, saves and undoes like any step). Refused if the design changed since; preview again. Returns the paint read back.",
    input: z.object({ preview: z.string().min(1).describe('The preview id from slicerx_paint_preview'), feature: featureArg }),
    async run(i) {
      const pv = previews.get(i.preview)
      if (!pv) throw new ToolInputError(`preview: no preview ${i.preview}; make one with slicerx_paint_preview`)
      const d = designs.get(pv.design)
      if (d.history.steps.length !== pv.steps || d.history.steps.at(-1)?.id !== pv.last) throw new ToolInputError('The design changed since this preview; preview again.')
      // the feature given here, else the one the preview was given
      const s = await designs.add(d, pv.part, pv.params, undefined, withFeature(i.feature?.trim() ? i.feature : pv.feature))
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
    version: '1.1.0',
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
