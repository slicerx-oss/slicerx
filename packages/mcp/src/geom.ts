// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh tools from sx-geom (cut, split, orient, repair, hollow, emboss,
// calibration models, resume plan). Like sx, the engine runs as a separate
// process, `sx-geom <op> --out-dir DIR < request.json`, so the server works with
// any build of it. The tools are mimir tools, so the permission gate applies:
// analysis is a read, anything that writes a new mesh is in the slice class.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { bakeMesh, invert, multiply, stepName, type HistoryMesh, type SolidSpec, type StepParams } from '@slicerx/cad-history'
import type { DesignHost } from '@slicerx/cad-history'
import { designArg, designSummary, faceAt, item, type Design } from './design'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import { findBinary } from './sx'
import { looksZipped, refuseVaultFile } from './vault'

/** Finds sx-geom: an explicit path, SLICERX_SX_GEOM_BIN, next to the sx binary, then PATH. */
export function findSxGeom(explicit?: string, sxPath?: string): string | undefined {
  const sibling = sxPath ? join(dirname(sxPath), process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom') : undefined
  return findBinary('sx-geom', explicit, [process.env['SLICERX_SX_GEOM_BIN'], sibling])
}

function runGeom(bin: string, op: string, request: unknown, outDir: string | undefined, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, outDir ? [op, '--out-dir', outDir] : [op], { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`sx-geom ${op} exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ') || 'no readable output'}`))
      }
      const err = (parsed as { error?: unknown }).error
      if (code !== 0 || typeof err === 'string') return reject(new ToolInputError(typeof err === 'string' ? err : `sx-geom ${op} failed with code ${code}`))
      resolve(parsed)
    })
    child.stdin.end(JSON.stringify(request))
  })
}

export const vec3 = z.tuple([z.number(), z.number(), z.number()])
export const modelArg = z.string().min(1).describe('Absolute path to an STL file, an http(s) URL, or a built-in model such as sample:x-mark or sample:cube-20')
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

const camel = (s: string): string => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
/** snake_case keys from the tool input become the camelCase keys sx-geom reads. */
function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [camel(k), camelKeys(x)]))
  return v
}

export interface GeomToolDeps {
  /** The sx-geom program, for tools that read and write STL files. */
  bin?: string | undefined
  policy: PathPolicy
  timeoutMs?: number
}

let counter = 0

export type GeomCall = (op: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Runs one operation. Returned meshes are STL files under <out>/geom/<run>/, given as stlPath. */
export function geomCaller(deps: GeomToolDeps): GeomCall {
  const timeout = deps.timeoutMs ?? 5 * 60_000
  return async (op, request) => {
    if (!deps.bin) throw new ToolInputError('Working on STL files needs the sx-geom program, which this server did not find; use a design instead.', 'not_supported')
    const dir = join(deps.policy.outDir, 'geom', `${op.replace(/\W+/g, '-')}-${Date.now().toString(36)}-${counter++}`)
    mkdirSync(dir, { recursive: true })
    return (await runGeom(deps.bin, op, camelKeys(request), dir, timeout)) as Record<string, unknown>
  }
}

/** The engine as a history replay calls it: JSON in, meshes back as numbers (with their faces), no files. */
export function geomEngine(bin: string, timeoutMs = 5 * 60_000): (op: string, request: unknown) => Promise<unknown> {
  return (op, request) => runGeom(bin, op, request, undefined, timeoutMs)
}

type V3 = [number, number, number]

const designOrModel = (i: { model?: string | undefined; design?: string | undefined }): void => {
  if (!i.model === !i.design) throw new ToolInputError(i.model ? 'give "model" or "design", not both' : 'give "model" (an STL) or "design" (a design id)')
}

const partArg = z.number().int().min(0).optional().describe('With a design: the part to work on, from 0; absent: every part')

export function geomTools(deps: GeomToolDeps & { designs?: DesignHost | undefined }): PilotTool<never>[] {
  const call = geomCaller(deps)
  const designOf = (id: string): [DesignHost, Design] => {
    if (!deps.designs) throw new ToolInputError('Designs need the sx-geom engine, which this server did not find.', 'not_supported')
    return [deps.designs, deps.designs.get(id)]
  }
  const added = (d: Design, verb: string) => {
    const s = d.history.steps[d.history.steps.length - 1]
    return { summary: `${verb}: step ${d.history.steps.length}${s ? `, ${stepName(s)}` : ''}`, output: designSummary(d) }
  }
  const modelOpt = modelArg.optional().describe('Absolute path to an STL file, an http(s) URL, or a built-in model; or give "design" instead')
  // sx-geom reads STL only; a 3MF would be read as a binary STL with nonsense counts.
  const stlOnly = (path: string): { stlPath: string } => {
    if (extname(path).toLowerCase() !== '.stl' || looksZipped(path)) {
      throw new ToolInputError(`${basename(path)} is not an STL. The mesh tools take STL files only; to work on a 3MF, export the object as STL from SlicerX first.`, 'unsupported_format')
    }
    return { stlPath: path }
  }
  const mesh = async (model: string): Promise<{ stlPath: string }> => stlOnly(await resolveModel(deps.policy, model))
  // Tools that write a new mesh never take a Vault design, and say so before saying it is not an STL.
  const meshOut = async (model: string): Promise<{ stlPath: string }> => {
    const path = await resolveModel(deps.policy, model)
    refuseVaultFile(path)
    return stlOnly(path)
  }

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

  const cut = defineTool({
    name: 'geom.cut',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description:
      'Cut a model or a design part with a plane into a lower and an upper piece with flat caps. With "design" it adds a step: keep both (the upper piece becomes a new part after it), or only the one below or above the plane. With a model it can add pin, dowel or dovetail connectors and writes two STL files.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      part: z.number().int().min(0).optional().describe('With a design: the part to cut, from 0 (default 0)'),
      keep: z.enum(['both', 'below', 'above']).default('both').describe('With a design: which pieces to keep'),
      plane,
      connector: connector.optional(),
    }),
    async run(i) {
      designOrModel(i)
      if (i.design) {
        if (i.connector) throw new ToolInputError('connector: a design cut has no connectors yet; cut the saved STL, or leave connector out', 'not_supported')
        const [ds, d] = designOf(i.design)
        await ds.add(d, i.part ?? 0, { op: 'plane.cut', plane: planeOf(i.plane), keep: i.keep })
        return added(d, 'Cut')
      }
      const out = await call('cut', { mesh: await meshOut(i.model!), plane: i.plane, options: i.connector ? { connector: i.connector } : {} })
      return { summary: 'Cut the model into two parts', output: out }
    },
  })

  const split = defineTool({
    name: 'geom.split',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description:
      'Split a model or a design part that is too big for the printer into pieces that each fit the build volume, with the fewest cuts. With "design" it adds a step and the pieces become parts; with a model it can turn pieces on the bed and add connectors, and writes one STL per piece.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      part: z.number().int().min(0).optional().describe('With a design: the part to split, from 0 (default 0)'),
      build_volume_mm: vec3.describe('Printable width, depth and height in mm'),
      margin_mm: z.number().min(0).max(50).optional(),
      allow_rotate_z: z.boolean().optional().describe('Parts may turn 90 degrees on the bed to fit'),
      connector: connector.optional(),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, part, ...options } = i
      if (design) {
        if (options.connector || options.allow_rotate_z) throw new ToolInputError('A design split takes the build volume and margin only; leave connector and allow_rotate_z out', 'not_supported')
        const [ds, d] = designOf(design)
        await ds.add(d, part ?? 0, { op: 'split', buildVolumeMm: options.build_volume_mm, ...(options.margin_mm !== undefined ? { marginMm: options.margin_mm } : {}) })
        return added(d, 'Split')
      }
      const out = await call('split', { mesh: await meshOut(model!), options })
      const parts = Array.isArray(out['parts']) ? out['parts'].length : 0
      return { summary: `Split the model into ${parts} part${parts === 1 ? '' : 's'}`, output: out }
    },
  })

  const mirror = defineTool({
    name: 'geom.mirror',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Mirror a design part through a plane, as a step: with copy (the default, like a mirror modifier) the mirror image is joined to the part, so a half becomes a whole; without it the part is flipped. Plane as {"axis":"x","at":0} or {"point":[x,y,z],"normal":[x,y,z]}.',
    input: z.object({ design: designArg, part: z.number().int().min(0).optional().describe('The part to mirror, from 0 (default 0)'), plane, copy: z.boolean().default(true) }),
    async run(i) {
      const [ds, d] = designOf(i.design)
      await ds.add(d, i.part ?? 0, { op: 'mirror', plane: planeOf(i.plane), copy: i.copy })
      return added(d, 'Mirrored')
    },
  })

  const arraySpec = z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('linear'), count: z.number().int().min(2).max(500), step: vec3.describe('Offset between neighbors, mm'), count2: z.number().int().min(1).max(500).optional(), step2: vec3.optional().describe('Offset between rows, mm') }),
      z.object({ kind: z.literal('circular'), count: z.number().int().min(2).max(500), center: vec3, axis: vec3.optional().describe('Default +Z'), angleDeg: z.number().min(1).max(360).optional().describe('Total angle; default 360'), rotateCopies: z.boolean().optional().describe('Turn each copy with the circle; default true') }),
    ])
    .describe('{"kind":"linear","count":4,"step":[25,0,0]} for a row (count2 and step2 make a grid), or {"kind":"circular","count":6,"center":[0,0,0]} around an axis')

  const array = defineTool({
    name: 'geom.array',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description:
      'Repeat a model or a design part in a row, a grid or around a circle (a pattern or array), like the Array tool: merged into one body, or with merge false as separate copies. With "design" it adds a step (separate copies become new parts); with a model it writes the merged STL, or returns each copy\'s transform.',
    input: z.object({ model: modelOpt, design: designArg.optional(), part: partArg, spec: arraySpec, merge: z.boolean().default(true).describe('false: separate copies instead of one body') }),
    async run(i) {
      designOrModel(i)
      const spec = JSON.parse(JSON.stringify(i.spec)) as Extract<StepParams, { op: 'array.merged' }>['spec']
      const copies = spec.kind === 'linear' ? spec.count * (spec.count2 ?? 1) : spec.count
      if (i.design) {
        const [ds, d] = designOf(i.design)
        if (i.merge) {
          await ds.add(d, i.part ?? -1, { op: 'array.merged', spec })
          return added(d, `Arrayed ${copies} copies`)
        }
        // Separate copies are new parts, placed where the engine puts each copy; the first is the part itself.
        const part = i.part ?? 0
        const src = d.parts[part]
        if (!src) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
        const r = (await ds.call('array', { mesh: item(d, part), spec })) as { transforms: number[][] }
        const back = invert(d.transform)
        const parts = r.transforms.slice(1).map((t, k) => ({ ...bakeMesh({ name: `${src.name} ${k + 2}`, slot: src.slot, positions: Array.from(src.positions), indices: Array.from(src.indices) }, multiply(back, t)) }))
        await ds.add(d, -1, { op: 'parts.add', parts, label: `Array of ${copies}, separate` })
        return added(d, `Arrayed ${copies} separate copies`)
      }
      const out = await call('array', { mesh: await meshOut(i.model!), spec, merge: i.merge })
      return { summary: `Arrayed ${copies} copies${i.merge ? '' : ', as transforms'}`, output: out }
    },
  })

  const orient = defineTool({
    name: 'geom.orient',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Rank candidate print orientations by overhang area, support volume, bed contact and height, best first, or score one orientation given as the direction that points down. Reports only; nothing is changed.',
    input: z.object({
      model: modelArg,
      down: vec3.optional().describe('Score this one orientation: the model direction that should face the bed, such as [0,0,-1]'),
      max_candidates: z.number().int().min(1).max(24).default(6),
      overhang_angle_deg: z.number().min(0).max(90).optional(),
    }),
    async run(i) {
      const options = i.overhang_angle_deg !== undefined ? { overhang_angle_deg: i.overhang_angle_deg } : {}
      const out = i.down
        ? await call('orient.analyze', { mesh: await mesh(i.model), orientation: { down: i.down }, options })
        : await call('orient.rank', { mesh: await mesh(i.model), options, max_candidates: i.max_candidates })
      return { summary: i.down ? 'Scored the orientation' : 'Ranked print orientations', output: out }
    },
  })

  const repair = defineTool({
    name: 'geom.repair',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Repair a mesh: weld vertices, fix winding and normals, and close small holes. With "design" it adds a repair step with the default options; with a model it writes a repaired STL and a report of what was fixed and what stayed open.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      part: partArg,
      close_holes: z.boolean().optional(),
      max_hole_edges: z.number().int().min(3).max(10_000).optional().describe('Holes with more boundary edges than this stay open'),
      fix_normals: z.boolean().optional(),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, part, ...options } = i
      if (design) {
        if (Object.values(options).some((v) => v !== undefined)) throw new ToolInputError('A repair step on a design takes the default options; leave close_holes, max_hole_edges and fix_normals out')
        const [ds, d] = designOf(design)
        await ds.add(d, part ?? -1, { op: 'repair' })
        return added(d, 'Repaired')
      }
      const out = await call('repair', { mesh: await meshOut(model!), options })
      return { summary: 'Repaired the mesh', output: out }
    },
  })

  const hollow = defineTool({
    name: 'geom.hollow',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Hollow a solid model to a shell of a given wall thickness, with optional drain holes so resin or trapped material can leave. With "design" it adds a hollow step (wall only); with a model it writes a new STL and a volume report.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      part: partArg,
      wall_mm: z.number().min(0.4).max(50).default(2),
      voxel_mm: z.number().min(0.05).max(5).optional().describe('Grid resolution; smaller is slower and more exact'),
      drain_holes: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe('sx-geom drain hole objects (see the sx-geom README)'),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, part, ...options } = i
      if (design) {
        if (options.voxel_mm !== undefined || options.drain_holes !== undefined) throw new ToolInputError('A hollow step on a design takes the wall only; leave voxel_mm and drain_holes out')
        const [ds, d] = designOf(design)
        await ds.add(d, part ?? -1, { op: 'hollow', wallMm: options.wall_mm })
        return added(d, 'Hollowed')
      }
      const out = await call('hollow', { mesh: await meshOut(model!), options })
      return { summary: 'Hollowed the model', output: out }
    },
  })

  const emboss = defineTool({
    name: 'geom.emboss',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Raise (emboss) or cut in (deboss) text on a face of the model. Give the point on the surface where the text is centered, and the face normal if the point is on an edge. With "design" it adds a text step on the plane through the point (flat faces); with a model it writes a new STL.',
    input: z.object({
      model: modelOpt,
      design: designArg.optional(),
      text: z.string().min(1).max(200).describe('Text to place; \\n starts a new line'),
      point: vec3.describe('Center of the text on the surface, mm'),
      normal: vec3.optional(),
      up: vec3.optional().describe('Text up direction; defaults to +Z, or +Y on a horizontal face'),
      size_mm: z.number().positive().max(200).describe('Capital letter height, mm'),
      depth_mm: z.number().positive().max(50).describe('Height of raised text or depth of the pocket, mm'),
      mode: z.enum(['emboss', 'deboss']).default('emboss'),
    }),
    async run(i) {
      designOrModel(i)
      const { model, design, ...spec } = i
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
        const params: StepParams = { op: 'shape.extrude', frame, shape: { type: 'text', text: i.text, sizeMm: i.size_mm }, spec: { distanceMm: i.depth_mm, operation: i.mode === 'deboss' ? 'cut' : 'join' } }
        await ds.add(d, f.part, params)
        return added(d, i.mode === 'deboss' ? 'Debossed' : 'Embossed')
      }
      const out = await call('emboss', { mesh: await meshOut(model!), spec })
      return { summary: `${i.mode === 'deboss' ? 'Debossed' : 'Embossed'} "${i.text.slice(0, 40)}"`, output: out }
    },
  })

  const calibration = defineTool({
    name: 'geom.calibration_model',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Generate a calibration print: temperature tower, flow pads, pressure advance, retraction, max volumetric speed, tolerance plate, shrinkage L, or the feature piece (a small print with a bridge, an overhang, a thin wall, a hole and text). Writes STL files and returns the per-object and per-height settings to apply (OrcaSlicer keys), reading instructions and the expected result.',
    input: z.object({
      test: z.enum(['temp-tower', 'flow', 'pressure-advance', 'retraction', 'max-volumetric', 'tolerance', 'shrinkage', 'feature-piece']),
      params: z.record(z.string(), z.unknown()).default({}).describe('Optional parameters of that test in snake_case; the defaults work'),
    }),
    async run(i) {
      const out = await call('calibrate', { test: i.test, ...(i.params as Record<string, unknown>) })
      return { summary: `Generated the ${i.test} calibration model`, output: out }
    },
  })

  const resume = defineTool({
    name: 'geom.resume_plan',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Plan resuming a failed print: from the height of the part left on the bed, or the layer the printer stopped at, find the first layer to print again and the remaining part of the model. Analysis only; it does not touch a printer.',
    input: z.object({
      model: modelArg,
      measured_height_mm: z.number().positive().optional().describe('Height of the part left on the bed, mm'),
      failed_layer: z.number().int().min(1).optional().describe('Layer number the printer showed when it stopped, counting from 1'),
      first_layer_height_mm: z.number().positive().default(0.2),
      layer_height_mm: z.number().positive().default(0.2),
    }),
    async run(i) {
      if (i.measured_height_mm === undefined && i.failed_layer === undefined) return { ok: false, summary: 'Give measured_height_mm or failed_layer' }
      const { model, ...req } = i
      const out = await call('resume', { mesh: await meshOut(model), ...req, includeRemainingMesh: true })
      return { summary: `Resume from layer ${String(out['resumeLayer'] ?? '?')}`, output: out }
    },
  })

  const solid = z.record(z.string(), z.unknown())
  const solidsHelp =
    'Solids as sx-geom objects with a "type": {"type":"box","min":[x,y,z],"max":[x,y,z]}, {"type":"cylinder","origin":[x,y,z],"axis":[x,y,z],"diameterMm":d,"heightMm":h}, or {"type":"prism","points":[[x,y],...],"origin":[...],"axis":[...],"heightMm":h}. Keys are camelCase, in mm.'

  const layers = defineTool({
    name: 'geom.layers_plan',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Plan variable layer heights (sleipnir) for a model: thinner layers where the shape needs detail, thicker where it does not, within the nozzle-based limits. Returns layer tops, heights, the zones and why, and how many layers and how much stair stepping it saves against a uniform plan. Reports only.',
    input: z.object({
      model: modelArg,
      nozzle_mm: z.number().min(0.1).max(2).default(0.4),
      mode: z.enum(['quality', 'strength']).default('quality'),
      options: z.record(z.string(), z.unknown()).optional().describe('Optional: minHeightMm, maxHeightMm, firstLayerMm, smoothing, maxStepRatio, zStepMm, baseHeightMm'),
    }),
    async run(i) {
      const out = await call('layers.plan', { mesh: await mesh(i.model), nozzle_mm: i.nozzle_mm, mode: i.mode, options: i.options ?? {} })
      const n = Array.isArray(out['heightsMm']) ? out['heightsMm'].length : 0
      return { summary: `Planned ${n} variable layers`, output: out }
    },
  })

  const build = defineTool({
    name: 'geom.build',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Build a new model from simple solids (boxes, cylinders, prisms), optionally cutting holes with convex cutters. Overlapping solids are joined. With "design" the result is added to the design as a new part; with no design it writes an STL and returns its volume, bounds and whether it is watertight. ${solidsHelp}`,
    input: z.object({
      solids: z.array(solid).min(1).max(64),
      subtract: z.array(solid).max(64).optional().describe('Convex cutters removed from every solid: box, cylinder, prism or countersink'),
      design: designArg.optional(),
      name: z.string().min(1).max(120).optional().describe('With a design: the name of the new part'),
      slot: z.number().int().min(1).max(32).optional().describe('With a design: the filament slot of the new part, from 1'),
    }),
    async run(i) {
      if (i.design) {
        const [ds, d] = designOf(i.design)
        const r = (await ds.call('build', { solids: i.solids, ...(i.subtract ? { subtract: i.subtract } : {}) })) as { mesh: { positions: number[]; indices: number[] } }
        // The mesh goes in the design's own frame, as the history keeps a part.
        const inv = invert(d.transform)
        const part: HistoryMesh = { name: i.name ?? `Solids ${d.parts.length + 1}`, slot: i.slot ?? 1, positions: transformPoints(r.mesh.positions, inv), indices: r.mesh.indices }
        await ds.add(d, -1, { op: 'parts.add', parts: [part], label: `Add ${part.name}` })
        return added(d, 'Built')
      }
      const out = await call('build', { solids: i.solids, ...(i.subtract ? { subtract: i.subtract } : {}) })
      return { summary: `Built a model from ${i.solids.length} solid${i.solids.length === 1 ? '' : 's'}`, output: out }
    },
  })

  const subtract = defineTool({
    name: 'geom.subtract',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Cut holes and pockets in an existing model with convex cutters, such as screw holes or a countersink: {"type":"countersink","origin":[x,y,z] on the surface,"axis":[...] into the material,"shaftDiameterMm":d,"headDiameterMm":D,"angleDeg":90,"depthMm":h}. Writes an STL and returns the removed volume. ${solidsHelp}`,
    input: z.object({ model: modelOpt, design: designArg.optional(), part: partArg, solids: z.array(solid).min(1).max(64), label: z.string().min(1).max(120).optional().describe('With a design: the step name') }),
    async run(i) {
      designOrModel(i)
      if (i.design) {
        const [ds, d] = designOf(i.design)
        const solids = i.solids.map(historySolid)
        const one = solids.length === 1 ? solids[0] : undefined
        const label = i.label ?? (one?.type === 'cylinder' ? `Hole ${Math.round(one.diameterMm * 100) / 100} mm` : `Subtract ${solids.length} solid${solids.length === 1 ? '' : 's'}`)
        await ds.add(d, i.part ?? -1, { op: 'subtract', solids, label })
        return added(d, 'Subtracted')
      }
      const out = await call('subtract', { mesh: await meshOut(i.model!), solids: i.solids })
      return { summary: `Removed ${String(out['removedVolumeMm3'] ?? '?')} mm3`, output: out }
    },
  })

  const render = defineTool({
    name: 'geom.render',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Draw a model to check it: a small orthographic picture (384 px on the long side unless size says otherwise) from a fixed view, the model in its filament color and painted pieces in theirs. Returns what is in view (bounds, triangles, painted area per filament slot); the PNG comes with the reply only when image is true, so ask for it when you need to look. Views: iso (front left, above), top, front, and fit (framed on the painted pieces or on focus, looking at them, so paint on an underside is seen from below). Nothing is changed.',
    input: z.object({
      model: modelArg,
      view: z.enum(['iso', 'top', 'front', 'fit']).default('iso'),
      size: z.number().int().min(64).max(2048).optional().describe('Long side of the picture in px; 384 when left out'),
      image: z.boolean().default(false).describe('Return the PNG with the reply. Leave false to get only the text summary'),
      colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(32).optional().describe('Filament colors by slot, slot 1 first, as #rrggbb'),
      slot: z.number().int().min(1).max(32).optional().describe('Filament slot of the model (its unpainted color); 1 when left out'),
      paint: z.record(z.string().regex(/^\d+$/), z.string().max(4096)).optional().describe('Color paint by triangle index, as the per-triangle paint text of a 3MF (state n is filament slot n)'),
      focus: z.object({ min: vec3, max: vec3 }).optional().describe('Box the fit view frames, mm'),
    }),
    async run(i) {
      const out = await call('render', {
        mesh: await mesh(i.model),
        view: i.view,
        ...(i.size !== undefined ? { size: i.size } : {}),
        ...(i.colors ? { colors: i.colors } : {}),
        ...(i.slot !== undefined ? { slot: i.slot } : {}),
        ...(i.paint ? { paint: i.paint } : {}),
        ...(i.focus ? { focus: i.focus } : {}),
      })
      const { pngPath, ...summary } = out as { pngPath?: string } & Record<string, unknown>
      const images = i.image && typeof pngPath === 'string' ? [{ mime: 'image/png' as const, data: readFileSync(pngPath).toString('base64') }] : undefined
      return {
        summary: `Drew ${basename(i.model)} from the ${i.view} view${images ? '' : ' (summary only; pass image: true for the picture)'}`,
        output: { ...summary, ...(typeof pngPath === 'string' ? { pngPath } : {}) },
        ...(images ? { images } : {}),
      }
    },
  })

  const paintRegions = defineTool({
    name: 'geom.paint_regions',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      'Read paint back: for one paint layer of a model (its per-triangle paint texts, as a 3MF stores them), each painted state with its area in mm2, the triangles holding it and its connected regions with their areas and bounds (largest first, at most 20 listed). For color paint, state n is filament slot n. Use it to check paint before slicing. Nothing is changed.',
    input: z.object({
      model: modelArg,
      paint: z.record(z.string().regex(/^\d+$/), z.string().max(4096)).describe('Paint texts by triangle index, one layer (color, seam, support or fuzzy skin)'),
    }),
    async run(i) {
      const out = (await call('paint.regions', { mesh: await mesh(i.model), paint: i.paint })) as { states?: { state: number; areaMm2: number }[]; badPaint?: number }
      const states = out.states ?? []
      const text = states.length ? states.map((s) => `state ${s.state} ${s.areaMm2} mm2`).join(', ') : 'nothing painted'
      return { summary: `Paint of ${basename(i.model)}: ${text}${out.badPaint ? `; ${out.badPaint} texts did not read` : ''}`, output: out }
    },
  })

  return [cut, split, mirror, array, orient, repair, hollow, emboss, calibration, resume, layers, build, subtract, render, paintRegions] as PilotTool<never>[]
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
