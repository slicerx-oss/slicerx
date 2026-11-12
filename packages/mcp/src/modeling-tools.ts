// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh modeling commands shared by the open app and the server. File access stays with the caller.
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { bakeMesh, checkedTextFit, direction, groupId, invert, keepsArrayOf, MAX_STEPS_REPEATED, multiply, point, repeatProblem, stepName, stepPatternProblem, textFitMessage, type FaceFrame, type HistoryMesh, type Polygon, type PrimitiveSpec, type SolidSpec, type StepParams } from '@slicerx/cad-history'
import type { DesignHost } from '@slicerx/cad-history'
import { designArg, designSummary, featureArg, withFeature, faceAt, landedNote, item, pieceNameFor, pieceNameNote, replayChange, stepIndex, type Design, type PiecePlans } from './design-tools'
import { frameFor } from './cad'
import { insetOutline, railLayout } from './rail'
import { ToolInputError } from './errors'
import { boxIn, boxOf, placeNote, solidBox, solidsInPlace, solidsNote, undercut } from './feature-place'
import type { FitProfile } from './fit-facts'
import { seatNew, seatPattern } from './seat'
import { modelArg, vec3, type GeomCall } from './args'

/** Files used only by model-file calls; a live design uses its host instead. */
export interface ModelingFiles {
  call: GeomCall
  /** Resolve an STL for an operation that writes a new mesh, enforcing the file policy. */
  mesh(model: string): Promise<{ stlPath: string }>
}

const plane = z
  .union([
    z.object({ axis: z.enum(['x', 'y', 'z']), at: z.number().describe('Position along the axis, mm') }),
    z.object({ point: vec3, normal: vec3 }),
  ])
  .describe('Cut plane: {"axis":"z","at":40} or {"point":[x,y,z],"normal":[x,y,z]}, in mm with Z up and the bed at Z = 0')
const connector = z
  .object({
    kind: z.enum(['pin', 'dowel', 'dovetail']),
    diameter_mm: z.number().positive().max(50).optional(),
    depth_mm: z.number().positive().max(100).optional(),
    tolerance_mm: z.number().min(0).max(2).optional(),
    count: z.number().int().min(1).max(16).optional(),
  })
  .describe('Alignment connector added at each cut, so the printed parts glue together in the right place')

type V3 = [number, number, number]

const designOrModel = (i: { model?: string | undefined; design?: string | undefined }): void => {
  if (!i.model === !i.design) throw new ToolInputError(i.model ? 'give "model" or "design", not both' : 'give "model" (an STL) or "design" (a design id)')
}

const partArg = z.number().int().min(0).optional().describe('With a design: the part to work on, from 0; absent: every part')

/** The rail reply's line on its two steps: what one undo takes, and how to change one of them. */
export const RAIL_UNDO_NOTE = 'one slicerx_design_undo takes both steps off, and slicerx_design_edit_step changes either one'

export function modelingTools(deps: { files: ModelingFiles; designs?: DesignHost | undefined; /** The plans a new part's piece name comes from (pieceNameFor). */ plans?: PiecePlans | undefined; /** The nozzle, mm, for the gap a new part is seated across (seat.ts); 0.4 without one. */ nozzleMm?: (() => number | undefined) | undefined; /** The layer height the part prints with, for the same. */ fitProfile?: (() => FitProfile) | undefined }): PilotTool<never>[] {
  const call = deps.files.call
  const meshOut = deps.files.mesh
  const designOf = (id: string): [DesignHost, Design] => {
    if (!deps.designs) throw new ToolInputError('Designs need the sx-geom engine, which this server did not find.', 'not_supported')
    return [deps.designs, deps.designs.get(id)]
  }
  const seatOpts = () => ({ nozzleMm: deps.nozzleMm?.(), layerHeightMm: deps.fitProfile?.().layerHeightMm, plans: deps.plans })
  /** An answer with what seating said after it, if anything. */
  const withSeat = <T extends { summary: string }>(out: T, said: string): T => (said ? { ...out, summary: `${out.summary.replace(/[.\s]+$/, '')}. ${said}` } : out)
  const added = (d: Design, verb: string) => {
    const s = d.history.steps[d.history.steps.length - 1]
    return { summary: `${verb}: step ${d.history.steps.length}${s ? `, ${stepName(s)}` : ''}${d.landed ? `. ${landedNote(d.landed, d.name)}` : ''}`, output: designSummary(d) }
  }
  /**
   * As added, with a pattern step's note (the copies it left out, which missed the part, named) and the same as data:
   * `copies`, how many there are, how many were kept and the numbers left out, from 1 as the note numbers them.
   */
  const addedPattern = (d: Design, verb: string) => {
    const r = added(d, verb)
    const st = d.status[d.status.length - 1]
    const withCopies = st?.copies ? { ...r, output: { ...r.output, copies: st.copies } } : r
    return st?.note ? { ...withCopies, summary: `${r.summary}. ${st.note.replace(/\.$/, '')}` } : withCopies
  }
  /** The text laid out on the step's frame against the picked face's outline, both in that frame. */
  const textFitOn = async (ds: DesignHost, d: Design, f: { part: number; triangle: number }, frame: FaceFrame, at: V3, text: string, sizeMm: number) => {
    const part = d.parts[f.part]!
    const pick = (await ds.call('face.pick', { mesh: { mesh: { positions: Array.from(part.positions), indices: Array.from(part.indices) }, transform: d.transform }, triangle: f.triangle, at })) as { frame: FaceFrame; outline: Polygon[] }
    const o = pick.frame
    const toStep = ([x, y]: [number, number]): [number, number] => {
      const w = [0, 1, 2].map((k) => o.origin[k]! + o.u[k]! * x + o.v[k]! * y - frame.origin[k]!)
      return [w[0]! * frame.u[0] + w[1]! * frame.u[1] + w[2]! * frame.u[2], w[0]! * frame.v[0] + w[1]! * frame.v[1] + w[2]! * frame.v[2]]
    }
    const outline = pick.outline.map((pg) => ({ outer: pg.outer.map(toStep), holes: pg.holes.map((h) => h.map(toStep)) }))
    const layout = async (s: number) => ((await ds.call('shape.profile', { shape: { type: 'text', text, sizeMm: s } })) as { polygons: Polygon[] }).polygons
    return checkedTextFit(layout, await layout(sizeMm), outline, sizeMm)
  }
  const modelOpt = modelArg.optional().describe('Absolute path to an STL file, an http(s) URL, or a built-in model; or give "design" instead')
  /** A plane as the tools take it, as a point and a normal. */
  const planeOf = (pl: z.infer<typeof plane>): { point: V3; normal: V3 } => {
    if ('axis' in pl) {
      const k = { x: 0, y: 1, z: 2 }[pl.axis]
      const point: V3 = [0, 0, 0]
      const normal: V3 = [0, 0, 0]
      point[k] = pl.at
      normal[k] = 1
      return { point, normal }
    }
    if (Math.hypot(...pl.normal) < 1e-9) throw new ToolInputError('plane: the normal must not be zero')
    return { point: pl.point, normal: pl.normal }
  }

  const cutInput = z.object({
    model: modelOpt,
    design: designArg.optional(),
    feature: featureArg,
    part: z.number().int().min(0).optional().describe('With a design: the part to cut, from 0 (default 0)'),
    keep: z.enum(['both', 'below', 'above']).default('both').describe('With a design: which pieces to keep'),
    name: z.string().min(1).max(120).optional().describe("With a design and keep both: the name of the upper piece; default the part's name and top"),
    plane,
    connector: connector.optional(),
  })

  const cut = defineTool({
    name: 'geom.cut',
    version: '1.4.0',
    source: 'command',
    permission: 'slice',
    description:
      'Cut a model or a design part with a plane into a lower and an upper piece with flat caps. With "design" it adds a step: keep both (the upper piece becomes a new part after it), or only the one below or above the plane. With a model it can add pin, dowel or dovetail connectors and writes two STL files.',
    input: cutInput,
    // a local model's form leaves out the upper piece's name, so its text costs a local model nothing
    localInput: cutInput.omit({ name: true }),
    async run(i) {
      designOrModel(i)
      if (i.design) {
        if (i.connector) throw new ToolInputError('connector: a design cut has no connectors yet; cut the saved STL, or leave connector out', 'not_supported')
        if (i.name !== undefined && i.keep !== 'both') throw new ToolInputError('name: only a cut that keeps both pieces makes a new part; leave name out')
        const [ds, d] = designOf(i.design)
        await ds.add(d, i.part ?? 0, { op: 'plane.cut', plane: planeOf(i.plane), keep: i.keep, ...(i.name !== undefined ? { name: i.name } : {}) }, undefined, withFeature(i.feature))
        return added(d, 'Cut')
      }
      const out = await call('cut', { mesh: await meshOut(i.model!), plane: i.plane, options: i.connector ? { connector: i.connector } : {} })
      return { summary: 'Cut the model into two parts', output: out }
    },
  })

  const split = defineTool({
    name: 'geom.split',
    version: '1.3.0',
    source: 'command',
    permission: 'slice',
    description:
      'Split a model or a design part that is too big for the printer into pieces that each fit the build volume, with the fewest cuts. With "design" it adds a step and the pieces become parts; with a model it can turn pieces on the bed and add connectors, and writes one STL per piece.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      feature: featureArg,
      part: z.number().int().min(0).optional().describe('With a design: the part to split, from 0 (default 0)'),
      build_volume_mm: vec3.describe('Printable width, depth and height in mm'),
      margin_mm: z.number().min(0).max(50).optional(),
      allow_rotate_z: z.boolean().optional().describe('Parts may turn 90 degrees on the bed to fit'),
      connector: connector.optional(),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, part, feature, ...options } = i
      if (design) {
        if (options.connector || options.allow_rotate_z) throw new ToolInputError('A design split takes the build volume and margin only; leave connector and allow_rotate_z out', 'not_supported')
        const [ds, d] = designOf(design)
        await ds.add(d, part ?? 0, { op: 'split', buildVolumeMm: options.build_volume_mm, ...(options.margin_mm !== undefined ? { marginMm: options.margin_mm } : {}) }, undefined, withFeature(feature))
        return added(d, 'Split')
      }
      const out = await call('split', { mesh: await meshOut(model!), options })
      const parts = Array.isArray(out['parts']) ? out['parts'].length : 0
      return { summary: `Split the model into ${parts} part${parts === 1 ? '' : 's'}`, output: out }
    },
  })

  /**
   * The steps a pattern repeats, as ids in the design's order, and the part they work on: each given by its index from
   * 1, its id, or the plan feature it builds (every step of that feature). Refused, with why, when one cannot be repeated.
   */
  const repeated = (d: Design, given: readonly (number | string)[], part: number | undefined): { ids: string[]; part: number } => {
    const all = d.history.steps
    const picked = new Set<number>()
    for (const g of given) {
      const feature = typeof g === 'string' && !all.some((s) => s.id === g) ? all.flatMap((s, k) => (s.feature && s.feature.trim().toLowerCase() === g.trim().toLowerCase() ? [k] : [])) : []
      if (feature.length) feature.forEach((k) => picked.add(k))
      else picked.add(stepIndex(d, g))
    }
    const ks = [...picked].sort((a, b) => a - b)
    if (ks.length > MAX_STEPS_REPEATED) throw new ToolInputError(`steps: a pattern repeats at most ${MAX_STEPS_REPEATED} steps; this names ${ks.length}`)
    for (const k of ks) {
      const why = repeatProblem(all[k]!)
      if (why) throw new ToolInputError(`steps: step ${k + 1}, ${stepName(all[k]!)}: ${why}`)
    }
    const on = all[ks[0]!]!.part
    if (ks.some((k) => all[k]!.part !== on)) throw new ToolInputError('steps: the steps a pattern repeats are all on one part; these work on different parts')
    if (part !== undefined && part !== on) throw new ToolInputError(`part: the steps named work on part ${on}; leave part out or give ${on}`)
    return { ids: ks.map((k) => all[k]!.id), part: on }
  }
  const stepsArg = z
    .array(z.union([z.number().int().min(1), z.string().min(1).max(200)]))
    .min(1)
    .max(MAX_STEPS_REPEATED)
    .optional()
    .describe('With a design: repeat these steps (a cut, boss, hole, push, fillet or paint from a point; each an index from 1, a step id, or a plan feature name for all its steps) on their own part instead of copying the whole part, as one step whose value is the count, so editing the step changes it')

  const mirror = defineTool({
    name: 'geom.mirror',
    version: '1.6.0',
    source: 'command',
    permission: 'slice',
    description:
      'Mirror a design part through a plane, as a step: with copy (the default, like a mirror modifier) the mirror image is joined to the part, so a half becomes a whole; without it the part is flipped. With steps, only those steps are mirrored onto their part (a cutout or boss built on one side, made on the other too), as one step. Plane as {"axis":"x","at":0} or {"point":[x,y,z],"normal":[x,y,z]}.',
    input: z.object({ design: designArg, feature: featureArg, part: z.number().int().min(0).optional().describe('The part to mirror, from 0 (default 0)'), plane, copy: z.boolean().default(true), steps: stepsArg }),
    async run(i) {
      const [ds, d] = designOf(i.design)
      if (i.steps) {
        if (!i.copy) throw new ToolInputError('copy: a mirror of steps keeps them and adds their mirror image; leave copy out')
        const { ids, part } = repeated(d, i.steps, i.part)
        await ds.add(d, part, { op: 'pattern', steps: ids, spec: { kind: 'mirror', plane: planeOf(i.plane) } }, undefined, withFeature(i.feature))
        return addedPattern(d, `Mirrored ${ids.length} step${ids.length === 1 ? '' : 's'}`)
      }
      await ds.add(d, i.part ?? 0, { op: 'mirror', plane: planeOf(i.plane), copy: i.copy }, undefined, withFeature(i.feature))
      // a mirror image a hair from another part, as its source is: the source's step moves and the image follows
      const said = i.copy ? await seatPattern(ds, d, i.part ?? 0, seatOpts()) : ''
      return withSeat(added(d, 'Mirrored'), said)
    },
  })

  const linearSpec = z.object({ kind: z.literal('linear'), count: z.number().int().min(2).max(500), step: vec3.describe('Offset between neighbors, mm'), count2: z.number().int().min(1).max(500).optional(), step2: vec3.optional().describe('Offset between rows, mm') })
  const circularSpec = z.object({ kind: z.literal('circular'), count: z.number().int().min(2).max(500), center: vec3, axis: vec3.optional().describe('Default +Z'), angleDeg: z.number().min(1).max(360).optional().describe('Total angle; default 360'), rotateCopies: z.boolean().optional().describe('Turn each copy with the circle; default true') })
  const ARRAY_SPEC_TEXT = '{"kind":"linear","count":4,"step":[25,0,0]} for a row (count2 and step2 make a grid), or {"kind":"circular","count":6,"center":[0,0,0]} around an axis'
  const arraySpec = z.discriminatedUnion('kind', [linearSpec.extend({ onSurface: z.literal(true).optional().describe('With steps: each copy slides onto the part\'s surface where it lands and turns to it, so a row of slits, windows or dents along a curved side keeps the first one\'s depth') }), circularSpec]).describe(ARRAY_SPEC_TEXT)
  // a local model's row has no onSurface, which only the cloud display guidance asks for; the tool takes it from either
  const localArraySpec = z.discriminatedUnion('kind', [linearSpec, circularSpec]).describe(ARRAY_SPEC_TEXT)

  const arrayInput = z.object({ model: modelOpt, design: designArg.optional(), feature: featureArg, part: partArg, spec: arraySpec, merge: z.boolean().default(true).describe('false: separate copies instead of one body'), steps: stepsArg })
  // a local model gets the description without the onSurface sentence
  const ARRAY_TEXT = 'Repeat a model or a design part in a row, a grid or around a circle (a pattern or array), like the Array tool: merged into one body, or with merge false as separate copies. With "design" it adds a step (separate copies become new parts); with a model it writes the merged STL, or returns each copy\'s transform. With steps, only those steps are repeated on their part (a row of windows, holes around a flange, from one built), as one step whose count can be edited later; the steps themselves are the first copy.'
  const array = defineTool({
    name: 'geom.array',
    version: '1.9.0',
    source: 'command',
    permission: 'slice',
    description:
      `${ARRAY_TEXT} On a curved side, set onSurface on the row so each copy follows the surface.`,
    localDescription: ARRAY_TEXT,
    input: arrayInput,
    localInput: arrayInput.extend({ spec: localArraySpec }),
    async run(i) {
      designOrModel(i)
      const spec = JSON.parse(JSON.stringify(i.spec)) as Extract<StepParams, { op: 'array.merged' }>['spec'] & { onSurface?: true }
      const copies = spec.kind === 'linear' ? spec.count * (spec.count2 ?? 1) : spec.count
      if (spec.kind === 'linear' && spec.onSurface && !i.steps) throw new ToolInputError('spec.onSurface: a row follows a surface when it repeats steps (a cut, a hole, a shape on a face); give steps')
      if (i.steps) {
        if (!i.design) throw new ToolInputError('steps: repeating steps works on a design; give its id as design')
        if (!i.merge) throw new ToolInputError('merge: repeated steps stay on their part; leave merge out')
        const why = stepPatternProblem(spec)
        if (why) throw new ToolInputError(`spec: ${why}`)
        const [ds, d] = designOf(i.design)
        const { ids, part } = repeated(d, i.steps, i.part)
        await ds.add(d, part, { op: 'pattern', steps: ids, spec }, undefined, withFeature(i.feature))
        return addedPattern(d, `Patterned ${ids.length} step${ids.length === 1 ? '' : 's'}, ${copies} copies`)
      }
      if (i.design) {
        const [ds, d] = designOf(i.design)
        if (i.merge) {
          await ds.add(d, i.part ?? -1, { op: 'array.merged', spec }, undefined, withFeature(i.feature))
          // copies a hair from another part, as the source is: the source's step moves and the copies follow
          const said = i.part !== undefined ? await seatPattern(ds, d, i.part, seatOpts()) : ''
          return withSeat(added(d, `Arrayed ${copies} copies`), said)
        }
        // Separate copies are new parts, placed where the engine puts each copy; the first is the part itself. The step
        // records the part copied, so a plan can name copy k as the part's own number plus k - 1 (design.check).
        const part = i.part ?? 0
        const src = d.parts[part]
        if (!src) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
        const r = (await ds.call('array', { mesh: item(d, part), spec })) as { transforms: number[][] }
        const back = invert(d.transform)
        const parts = r.transforms.slice(1).map((t, k) => ({ ...bakeMesh({ name: `${src.name} ${k + 2}`, slot: src.slot, positions: Array.from(src.positions), indices: Array.from(src.indices) }, multiply(back, t)) }))
        // a name the project file would drop on reopening is not recorded, so the copies match the same way after it
        const n = d.parts.length
        await ds.add(d, -1, { op: 'parts.add', parts, label: `Array of ${copies}, separate`, ...(keepsArrayOf(src.name) ? { arrayOf: src.name } : {}) }, undefined, withFeature(i.feature))
        // separate copies a hair from another part are named, not moved
        const said = await seatNew(ds, d, Array.from({ length: Math.max(0, d.parts.length - n) }, (_, k) => n + k), seatOpts())
        return withSeat(added(d, `Arrayed ${copies} separate copies`), said)
      }
      const out = await call('array', { mesh: await meshOut(i.model!), spec, merge: i.merge })
      return { summary: `Arrayed ${copies} copies${i.merge ? '' : ', as transforms'}`, output: out }
    },
  })

  const repair = defineTool({
    name: 'geom.repair',
    version: '1.2.0',
    source: 'command',
    permission: 'slice',
    description: 'Repair a mesh: weld vertices, fix winding and normals, and close small holes. With "design" it adds a repair step with the default options; with a model it writes a repaired STL and a report of what was fixed and what stayed open.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      close_holes: z.boolean().optional(),
      max_hole_edges: z.number().int().min(3).max(10_000).optional().describe('Holes with more boundary edges than this stay open'),
      fix_normals: z.boolean().optional(),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, part, feature, ...options } = i
      if (design) {
        if (Object.values(options).some((v) => v !== undefined)) throw new ToolInputError('A repair step on a design takes the default options; leave close_holes, max_hole_edges and fix_normals out')
        const [ds, d] = designOf(design)
        await ds.add(d, part ?? -1, { op: 'repair' }, undefined, withFeature(feature))
        return added(d, 'Repaired')
      }
      const out = await call('repair', { mesh: await meshOut(model!), options })
      return { summary: 'Repaired the mesh', output: out }
    },
  })

  const hollow = defineTool({
    name: 'geom.hollow',
    version: '1.2.0',
    source: 'command',
    permission: 'slice',
    description: 'Hollow a solid model to a shell of a given wall thickness, with optional drain holes so resin or trapped material can leave. With "design" it adds a hollow step (wall only); with a model it writes a new STL and a volume report.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      feature: featureArg,
      part: partArg,
      wall_mm: z.number().min(0.4).max(50).default(2),
      voxel_mm: z.number().min(0.05).max(5).optional().describe('Grid resolution; smaller is slower and more exact'),
      drain_holes: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe('sx-geom drain hole objects (see the sx-geom README)'),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, part, feature, ...options } = i
      if (design) {
        if (options.voxel_mm !== undefined || options.drain_holes !== undefined) throw new ToolInputError('A hollow step on a design takes the wall only; leave voxel_mm and drain_holes out')
        const [ds, d] = designOf(design)
        await ds.add(d, part ?? -1, { op: 'hollow', wallMm: options.wall_mm }, undefined, withFeature(feature))
        return added(d, 'Hollowed')
      }
      const out = await call('hollow', { mesh: await meshOut(model!), options })
      return { summary: 'Hollowed the model', output: out }
    },
  })

  const emboss = defineTool({
    name: 'geom.emboss',
    version: '1.4.0',
    source: 'command',
    permission: 'slice',
    description: 'Raise (emboss) or cut in (deboss) text on a face of the model. Give the point on the surface where the text is centered, and the face normal if the point is on an edge. With "design" it adds a text step on the plane through the point (flat faces); with a model it writes a new STL. With a design, textFit in the reply compares the text with the face, along the text and across it (mm), and gives the largest letter height that fits (fitSizeMm).',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      feature: featureArg,
      text: z.string().min(1).max(200).describe('Text to place; \\n starts a new line'),
      point: vec3.describe('Center of the text on the surface, mm'),
      normal: vec3.optional(),
      up: vec3.optional().describe('Text up direction; defaults to +Z, or +Y on a horizontal face'),
      size_mm: z.number().positive().max(200).describe('Capital letter height, mm'),
      depth_mm: z.number().positive().max(50).describe('Height of raised text or depth of the pocket, mm'),
      mode: z.enum(['emboss', 'deboss']).default('emboss'),
      slot: z.number().int().min(1).max(32).optional().describe('With a design and emboss: the raised text becomes a part of its own in this filament, from 1, such as white letters on a black tag'),
      name: z.string().min(1).max(120).optional().describe('With a design and slot: the name of the text part'),
    }),
    async run(i) {
      designOrModel(i)
      if (i.slot !== undefined && !i.design) throw new ToolInputError('slot: a filament for the text is for a design; give the design, or leave slot out')
      if (i.slot !== undefined && i.mode === 'deboss') throw new ToolInputError('slot: debossed text is a pocket in the part, with no filament of its own; leave slot out')
      if (i.name !== undefined && i.slot === undefined) throw new ToolInputError('name: the text is a part of its own only with a slot; give slot, or leave name out')
      const { model, design, slot: _slot, name: _name, ...spec } = i
      if (design) {
        const [ds, d] = designOf(design)
        const f = faceAt(d, i.point, i.normal)
        const n = f.normal
        // Text reads upright: up along +Z, or along +Y on a face that looks up or down.
        const up: V3 = i.up ?? (Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1])
        const u: V3 = [up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]]
        const l = Math.hypot(...u)
        if (l < 1e-9) throw new ToolInputError('up: must not be along the face normal')
        const uu: V3 = [u[0] / l, u[1] / l, u[2] / l]
        const frame = { origin: i.point, normal: n, u: uu, v: [n[1] * uu[2] - n[2] * uu[1], n[2] * uu[0] - n[0] * uu[2], n[0] * uu[1] - n[1] * uu[0]] as V3 }
        // with a slot, the raised letters are a new part of their own standing on the face, in that filament
        const own = i.slot
        const params: StepParams = { op: 'shape.extrude', frame, shape: { type: 'text', text: i.text, sizeMm: i.size_mm }, spec: { distanceMm: i.depth_mm, operation: own !== undefined ? 'new' : i.mode === 'deboss' ? 'cut' : 'join' }, ...(own !== undefined ? { name: i.name ?? `Text ${i.text.slice(0, 40)}`, slot: own } : {}) }
        // The text against the face it goes on, as the app's Text on a face checks it before Apply.
        const fit = await textFitOn(ds, d, f, frame, i.point, i.text, i.size_mm)
        const words = textFitMessage(fit)
        try {
          await ds.add(d, own !== undefined ? d.parts.length : f.part, params, undefined, withFeature(i.feature))
        } catch (e) {
          // a join that runs off the face is refused; the refusal says by how much and what size fits
          if (words && e instanceof Error) e.message = `${e.message} ${words}`
          throw e
        }
        const r = added(d, i.mode === 'deboss' ? 'Debossed' : 'Embossed')
        return { summary: words ? `${r.summary}. ${words}` : r.summary, output: { ...r.output, ...(fit ? { textFit: { ...fit, message: words } } : {}) } }
      }
      const out = await call('emboss', { mesh: await meshOut(model!), spec })
      return { summary: `${i.mode === 'deboss' ? 'Debossed' : 'Embossed'} "${i.text.slice(0, 40)}"`, output: out }
    },
  })

  const solid = z.record(z.string(), z.unknown())
  const solidsHelp =
    'Solids as sx-geom objects with a "type": {"type":"box","min":[x,y,z],"max":[x,y,z]}, {"type":"cylinder","origin":[x,y,z],"axis":[x,y,z],"diameterMm":d,"heightMm":h}, or {"type":"prism","points":[[x,y],...],"origin":[...],"axis":[...],"heightMm":h}. Keys are camelCase, in mm.'

  const build = defineTool({
    name: 'geom.build',
    version: '1.7.0',
    source: 'command',
    permission: 'slice',
    description: `Build a new model from simple solids (boxes, cylinders, prisms), optionally cutting holes with convex cutters. Overlapping solids are joined. With "design" the result is added to the design as a new part; with no design it writes an STL and returns its volume, bounds and whether it is watertight. ${solidsHelp}`,
    input: z.object({
      solids: z.array(solid).min(1).max(64),
      subtract: z.array(solid).max(64).optional().describe('Convex cutters removed from every solid: box, cylinder, prism or countersink'),
      design: designArg.optional(),
      feature: featureArg,
      name: z.string().min(1).max(120).optional().describe('With a design: the name of the new part'),
      slot: z.number().int().min(1).max(32).optional().describe('With a design: the filament slot of the new part, from 1'),
    }),
    async run(i) {
      if (i.design) {
        const [ds, d] = designOf(i.design)
        const r = (await ds.call('build', { solids: i.solids, ...(i.subtract ? { subtract: i.subtract } : {}) })) as { mesh: { positions: number[]; indices: number[] } }
        // The mesh goes in the design's own frame, as the history keeps a part.
        const inv = invert(d.transform)
        const shape = i.subtract?.length || i.solids.length !== 1 ? undefined : primitiveOf(i.solids[0]!, inv)
        // a part that builds a print-in-place piece of the design's plan takes the plan's name for it
        const piece = pieceNameFor(deps.plans, d, i.feature, i.name)
        const part: HistoryMesh = { name: piece ?? i.name ?? `Solids ${d.parts.length + 1}`, slot: i.slot ?? 1, positions: transformPoints(r.mesh.positions, inv), indices: r.mesh.indices, ...(shape ? { primitive: shape } : {}) }
        // a new part never stands where another part already stands on the same face, solid by solid
        // each box or cylinder by its own box; a part with another kind of solid is read whole, by its mesh's box
        const own = i.solids.map((s) => {
          try {
            return boxIn(solidBox(historySolid(s as Record<string, unknown>)), inv)
          } catch {
            return null
          }
        })
        const inWay = solidsInPlace(d.parts, own.every((b) => b) ? own : [boxOf(part.positions)])
        if (inWay.length) throw new ToolInputError(solidsNote(inWay))
        const n = d.parts.length
        await ds.add(d, -1, { op: 'parts.add', parts: [part], label: `Add ${part.name}` }, undefined, withFeature(i.feature))
        // a new part a hair from another (under the gap a printer keeps open) is seated on it, as this step
        const seat = await seatNew(ds, d, Array.from({ length: Math.max(0, d.parts.length - n) }, (_, k) => n + k), { nozzleMm: deps.nozzleMm?.(), layerHeightMm: deps.fitProfile?.().layerHeightMm, plans: deps.plans })
        const built = added(d, 'Built')
        const named = piece ? { ...built, summary: `${built.summary}${pieceNameNote(piece, i.name)}` } : built
        return seat ? { ...named, summary: `${named.summary.replace(/[.\s]+$/, '')}. ${seat}` } : named
      }
      const out = await call('build', { solids: i.solids, ...(i.subtract ? { subtract: i.subtract } : {}) })
      return { summary: `Built a model from ${i.solids.length} solid${i.solids.length === 1 ? '' : 's'}`, output: out }
    },
  })

  const subtract = defineTool({
    name: 'geom.subtract',
    version: '1.3.0',
    source: 'command',
    permission: 'slice',
    description: `Cut holes and pockets in an existing model with convex cutters, such as screw holes or a countersink: {"type":"countersink","origin":[x,y,z] on the surface,"axis":[...] into the material,"shaftDiameterMm":d,"headDiameterMm":D,"angleDeg":90,"depthMm":h}. Writes an STL and returns the removed volume. ${solidsHelp}`,
    input: z.object({ model: modelOpt, design: designArg.optional(), feature: featureArg, part: partArg, solids: z.array(solid).min(1).max(64), label: z.string().min(1).max(120).optional().describe('With a design: the step name') }),
    async run(i) {
      designOrModel(i)
      if (i.design) {
        const [ds, d] = designOf(i.design)
        const solids = i.solids.map(historySolid)
        const one = solids.length === 1 ? solids[0] : undefined
        const label = i.label ?? (one?.type === 'cylinder' ? `Hole ${Math.round(one.diameterMm * 100) / 100} mm` : `Subtract ${solids.length} solid${solids.length === 1 ? '' : 's'}`)
        // a cut never runs under a part standing on the face it cuts
        const inWay = undercut(d.parts, i.part ?? -1, solids)
        if (inWay.length) throw new ToolInputError(placeNote('cut', inWay, solids.length === 1 ? solidBox(solids[0]!) : null))
        await ds.add(d, i.part ?? -1, { op: 'subtract', solids, label }, undefined, withFeature(i.feature))
        return added(d, 'Subtracted')
      }
      const out = await call('subtract', { mesh: await meshOut(i.model!), solids: i.solids })
      return { summary: `Removed ${String(out['removedVolumeMm3'] ?? '?')} mm3`, output: out }
    },
  })


  /** How far a rail's posts sink into what they stand on, mm, so they are never exactly on its top. */
  const RAIL_SINK_MM = 0.05
  const railInput = z.object({
    design: designArg,
    feature: featureArg,
    path: z
      .object({
        frame: z.object({ origin: vec3, normal: vec3, u: vec3.optional() }).optional().describe('The plane the rail stands on, its normal up the posts; absent: the bed'),
        points: z.array(z.tuple([z.number(), z.number()])).min(2).max(512).describe('[u, v] in the plane, mm'),
        closed: z.boolean().default(false).describe('Back to the first point: a rail all round'),
      })
      .optional()
      .describe('The line the rail follows'),
    face: z
      .object({ point: vec3.describe('A point on the face, mm'), normal: vec3.optional() })
      .optional()
      .describe('Instead of path: a rail all round the outer edge of this flat face (a deck, a tray floor, a shelf)'),
    inset_mm: z.number().min(0).max(100).optional().describe('With face: how far in from the edge the rail\'s middle runs; default half the bar, so the bar\'s outside is on the edge'),
    height_mm: z.number().positive().max(500).describe('From the plane to the top of the bar, mm'),
    spacing_mm: z.number().positive().max(500).default(3).describe('Most distance between posts, mm; a post stands at every corner and the rest are spread evenly between'),
    post_mm: z.number().positive().max(50).optional().describe('Post diameter; default twice the nozzle'),
    bar_mm: z.number().positive().max(50).optional().describe('Top bar width, at least 0.1 mm over the posts; default the posts and 0.2 mm'),
    bar_height_mm: z.number().positive().max(50).optional().describe('Top bar thickness; default twice the nozzle'),
    part: partArg.describe('With join: the part the rail joins; with face, the face\'s part'),
    join: z.boolean().default(false).describe('Join the rail to the part it stands on; default a new part of its own'),
    name: z.string().min(1).max(120).optional().describe('The new part\'s name; default Rail'),
    slot: z.number().int().min(1).max(32).optional().describe('The new part\'s filament, from 1'),
  })
  const rail = defineTool({
    name: 'geom.rail',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Add a rail (a railing or fence) to a design: round posts at every corner of a line and spread evenly between, and a flat top bar on them, as two steps of one call. The line is path (points on a plane, closed for a rail all round) or face (all round the outer edge of a flat face). Posts and bar are at least twice the nozzle, so they print, and the bar is a little wider than the posts; the posts sink 0.05 mm into what they stand on. A new part of its own by default (name, slot), or joined to the part. The reply gives the posts, their spacing, the length and the sizes used.',
    input: railInput,
    async run(i) {
      if (!i.path === !i.face) throw new ToolInputError(i.path ? 'face: give path or face, not both' : 'path: give the line the rail follows as path, or a flat face as face')
      if (i.inset_mm !== undefined && !i.face) throw new ToolInputError('inset_mm: the inset is from a face\'s edge; give face, or leave inset_mm out')
      if (i.join && (i.name !== undefined || i.slot !== undefined)) throw new ToolInputError(`${i.name !== undefined ? 'name' : 'slot'}: a joined rail is part of the part it stands on; leave ${i.name !== undefined ? 'name' : 'slot'} out, or join out`)
      const nozzle = deps.nozzleMm?.() ?? 0.4
      const least = Math.round(2 * nozzle * 100) / 100
      const postMm = i.post_mm ?? least
      // the bar a little wider than the posts, so it caps them and no post's side runs along the bar's
      const barMm = i.bar_mm ?? Math.round((postMm + 0.2) * 100) / 100
      const barHeightMm = i.bar_height_mm ?? least
      for (const [k, v] of [['post_mm', postMm], ['bar_mm', barMm]] as const) if (v < least - 1e-9) throw new ToolInputError(`${k}: ${v} mm is thinner than a ${nozzle} mm nozzle prints; give at least ${least} mm (twice the nozzle)`)
      if (barMm < postMm + 0.1 - 1e-9) throw new ToolInputError(`bar_mm: the bar caps the posts, so it is at least 0.1 mm wider than they are; give at least ${Math.round((postMm + 0.1) * 100) / 100} mm`)
      if (barHeightMm >= i.height_mm) throw new ToolInputError(`height_mm: the rail is ${i.height_mm} mm tall and its bar ${barHeightMm} mm thick; give a height above the bar's thickness`)
      if (i.spacing_mm < postMm) throw new ToolInputError(`spacing_mm: posts ${postMm} mm wide cannot stand ${i.spacing_mm} mm apart; give at least ${postMm} mm`)
      const [ds, d] = designOf(i.design)
      let frame: FaceFrame
      let points: [number, number][]
      let closed: boolean
      let on = i.part
      if (i.face) {
        const f = faceAt(d, i.face.point, i.face.normal)
        if (i.part !== undefined && i.part !== f.part) throw new ToolInputError(`part: the face is on part ${f.part}; leave part out or give ${f.part}`)
        on = f.part
        const p = d.parts[f.part]!
        const pick = (await ds.call('face.pick', { mesh: { mesh: { positions: Array.from(p.positions), indices: Array.from(p.indices) }, transform: d.transform }, triangle: f.triangle, at: i.face.point })) as { frame: FaceFrame; outline: Polygon[] }
        const areaOf = (q: readonly [number, number][]) => Math.abs(q.reduce((s, a, k) => s + a[0] * q[(k + 1) % q.length]![1] - q[(k + 1) % q.length]![0] * a[1], 0))
        const outer = [...(pick.outline ?? [])].map((g) => g.outer as [number, number][]).sort((a, b) => areaOf(b) - areaOf(a))[0]
        if (!outer || outer.length < 3) throw new ToolInputError('face: no flat face with an edge all round at that point; give a point on a flat face')
        frame = pick.frame
        points = insetOutline(outer, i.inset_mm ?? barMm / 2)
        closed = true
      } else {
        const f = i.path!.frame
        frame = f ? frameFor(f.origin, f.normal, f.u) : { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
        points = i.path!.points
        closed = i.path!.closed
      }
      if (i.join && on === undefined) throw new ToolInputError('part: a joined rail needs the part it joins; give part')
      if (on !== undefined && !d.parts[on]) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
      const lay = railLayout(points, closed, { spacingMm: i.spacing_mm, barMm, capMm: barMm / 2 })
      if (typeof lay === 'string') throw new ToolInputError(`${i.face ? 'face' : 'path.points'}: ${lay}`)
      const n = d.parts.length
      const target = i.join ? on! : n
      const before = d.history
      const posts: StepParams = { op: 'shape.extrude', frame, shape: { type: 'sketch', loops: lay.posts.map((c) => ({ type: 'circle' as const, center: c, diameterMm: postMm })) }, spec: { distanceMm: i.height_mm - barHeightMm / 2, extent: 'twoSides', distance2Mm: RAIL_SINK_MM, operation: i.join ? 'join' : 'new' }, ...(i.join ? {} : { name: i.name ?? 'Rail', slot: i.slot ?? d.parts[on ?? 0]?.slot ?? 1 }) }
      // the posts reach halfway up the bar, so no top of theirs lies in the bar's top face
      const up = i.height_mm - barHeightMm
      const top: FaceFrame = { ...frame, origin: [frame.origin[0] + frame.normal[0] * up, frame.origin[1] + frame.normal[1] * up, frame.origin[2] + frame.normal[2] * up] }
      const bar: StepParams = { op: 'shape.extrude', frame: top, shape: { type: 'sketch', loops: lay.bar }, spec: { distanceMm: barHeightMm, operation: 'join' } }
      // one call, one undo: the posts and the bar share a group
      const group = { group: groupId() }
      await ds.add(d, target, posts, `Rail posts, ${lay.posts.length}`, withFeature(i.feature, group))
      try {
        await ds.add(d, target, bar, 'Rail bar', withFeature(i.feature, group))
      } catch (e) {
        // the rail is one call: without its bar the posts go too, and the design is as it was
        await replayChange(ds, d, before)
        throw e
      }
      const facts = { part: target, posts: lay.posts.length, cornerPosts: lay.cornerPosts, spacingMm: lay.spacingMm, lengthMm: lay.lengthMm, closed, heightMm: i.height_mm, postMm, barMm, barHeightMm }
      const k = d.history.steps.length
      return {
        summary: `Railed: steps ${k - 1} and ${k}, ${lay.posts.length} posts (${lay.cornerPosts} on corners) at most ${Math.round(lay.spacingMm * 100) / 100} mm apart along ${Math.round(lay.lengthMm * 10) / 10} mm, ${i.height_mm} mm tall, ${i.join ? `joined to ${d.parts[target]?.name ?? `part ${target}`}` : `a new part, ${d.parts[target]?.name ?? 'Rail'}`}; ${RAIL_UNDO_NOTE}${d.landed ? `. ${landedNote(d.landed, d.name)}` : ''}`,
        output: { ...designSummary(d), rail: facts },
      }
    },
  })

  return [cut, split, mirror, array, repair, hollow, emboss, build, subtract, rail] as PilotTool<never>[]
}

/** A cutter as a subtract step keeps it: a box, or a cylinder with its origin, axis, diameter and height. */
function historySolid(s: Record<string, unknown>): SolidSpec {
  const v3 = (x: unknown): V3 | undefined => (Array.isArray(x) && x.length === 3 && x.every((c) => typeof c === 'number' && Number.isFinite(c)) ? (x as V3) : undefined)
  if (s['type'] === 'box') {
    const min = v3(s['min'])
    const max = v3(s['max'])
    if (!min || !max) throw new ToolInputError('solids: a box needs "min" and "max", [x,y,z] in mm')
    return { type: 'box', min, max }
  }
  if (s['type'] === 'cylinder') {
    const d = typeof s['diameterMm'] === 'number' ? s['diameterMm'] : typeof s['radiusMm'] === 'number' ? s['radiusMm'] * 2 : NaN
    const h = s['heightMm']
    if (!(d > 0) || typeof h !== 'number' || !(h > 0)) throw new ToolInputError('solids: a cylinder needs diameterMm (or radiusMm) and heightMm, more than 0')
    return { type: 'cylinder', origin: v3(s['origin']) ?? [0, 0, 0], axis: v3(s['axis']) ?? [0, 0, 1], diameterMm: d, heightMm: h }
  }
  throw new ToolInputError(`solids: a design's subtract step takes boxes and cylinders; a ${String(s['type'])} cut needs a model (or build it as its own part)`)
}

/**
 * A part built from one box or cylinder, tagged with that shape in the design's frame as Add shape tags its parts, so
 * an exact replay can build it as a true solid (the replay checks the triangles still fit it).
 */
function primitiveOf(s: Record<string, unknown>, inv: number[]): PrimitiveSpec | undefined {
  const vec = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  const num = (v: unknown): v is number => typeof v === 'number' && v > 0
  const placed = (origin: [number, number, number], u: [number, number, number], normal: [number, number, number]) => ({ origin: point(inv, origin), u: direction(inv, u), normal: direction(inv, normal) })
  if (s['type'] === 'box' && vec(s['min']) && vec(s['max'])) {
    const [lo, hi] = [s['min'], s['max']]
    const size: [number, number, number] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    if (!size.every((x) => x > 0)) return undefined
    return { type: 'box', sizeMm: size, frame: placed([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]], [1, 0, 0], [0, 0, 1]) }
  }
  if (s['type'] === 'cylinder' && vec(s['origin']) && vec(s['axis']) && num(s['diameterMm']) && num(s['heightMm'])) {
    const a = s['axis']
    const l = Math.hypot(...a)
    if (!(l > 0)) return undefined
    const n: [number, number, number] = [a[0] / l, a[1] / l, a[2] / l]
    // any direction across the axis; a cylinder is the same all round
    const seed: [number, number, number] = Math.abs(n[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1]
    const c: [number, number, number] = [seed[1] * n[2] - seed[2] * n[1], seed[2] * n[0] - seed[0] * n[2], seed[0] * n[1] - seed[1] * n[0]]
    const cl = Math.hypot(...c)
    return { type: 'cylinder', diameterMm: s['diameterMm'], heightMm: s['heightMm'], frame: placed(s['origin'], [c[0] / cl, c[1] / cl, c[2] / cl], n) }
  }
  return undefined
}

function transformPoints(p: readonly number[], m: number[]): number[] {
  const out = new Array<number>(p.length)
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i]!
    const y = p[i + 1]!
    const z = p[i + 2]!
    out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
  }
  return out
}
