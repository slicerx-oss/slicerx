// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Mesh tools from sx-geom (cut, split, orient, repair, hollow, emboss,
// calibration models, resume plan). Like sx, the engine runs as a separate
// process, `sx-geom <op> --out-dir DIR < request.json`, so the server works with
// any build of it. The tools are mimir tools, so the permission gate applies:
// analysis is a read, anything that writes a new mesh is in the slice class.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import { findBinary } from './sx'
import { looksZipped, refuseVaultFile } from './vault'

/** Finds sx-geom: an explicit path, SLICERX_SX_GEOM_BIN, next to the sx binary, then PATH. */
export function findSxGeom(explicit?: string, sxPath?: string): string | undefined {
  const sibling = sxPath ? join(dirname(sxPath), process.platform === 'win32' ? 'sx-geom.exe' : 'sx-geom') : undefined
  return findBinary('sx-geom', explicit, [process.env['SLICERX_SX_GEOM_BIN'], sibling])
}

function runGeom(bin: string, op: string, request: unknown, outDir: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [op, '--out-dir', outDir], { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs })
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
  bin: string
  policy: PathPolicy
  timeoutMs?: number
}

let counter = 0

export type GeomCall = (op: string, request: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Runs one operation. Returned meshes are STL files under <out>/geom/<run>/, given as stlPath. */
export function geomCaller(deps: GeomToolDeps): GeomCall {
  const timeout = deps.timeoutMs ?? 5 * 60_000
  return async (op, request) => {
    const dir = join(deps.policy.outDir, 'geom', `${op.replace(/\W+/g, '-')}-${Date.now().toString(36)}-${counter++}`)
    mkdirSync(dir, { recursive: true })
    return (await runGeom(deps.bin, op, camelKeys(request), dir, timeout)) as Record<string, unknown>
  }
}

export function geomTools(deps: GeomToolDeps): PilotTool<never>[] {
  const call = geomCaller(deps)
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

  const cut = defineTool({
    name: 'geom.cut',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Cut a model with a plane into a lower and an upper part with flat caps, optionally with pin, dowel or dovetail connectors. Writes two STL files and returns their paths.',
    input: z.object({ model: modelArg, plane, connector: connector.optional() }),
    async run(i) {
      const out = await call('cut', { mesh: await meshOut(i.model), plane: i.plane, options: i.connector ? { connector: i.connector } : {} })
      return { summary: 'Cut the model into two parts', output: out }
    },
  })

  const split = defineTool({
    name: 'geom.split',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Split a model that is too big for the printer into parts that each fit the build volume, with the fewest cuts, optionally with connectors. Writes one STL per part.',
    input: z.object({
      model: modelArg,
      build_volume_mm: vec3.describe('Printable width, depth and height in mm'),
      margin_mm: z.number().min(0).max(50).optional(),
      allow_rotate_z: z.boolean().optional().describe('Parts may turn 90 degrees on the bed to fit'),
      connector: connector.optional(),
    }),
    async run(i) {
      const { model, ...options } = i
      const out = await call('split', { mesh: await meshOut(model), options })
      const parts = Array.isArray(out['parts']) ? out['parts'].length : 0
      return { summary: `Split the model into ${parts} part${parts === 1 ? '' : 's'}`, output: out }
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
    description: 'Repair a mesh: weld vertices, fix winding and normals, and close small holes. Writes a repaired STL and a report of what was fixed and what stayed open.',
    input: z.object({
      model: modelArg,
      close_holes: z.boolean().optional(),
      max_hole_edges: z.number().int().min(3).max(10_000).optional().describe('Holes with more boundary edges than this stay open'),
      fix_normals: z.boolean().optional(),
    }),
    async run(i) {
      const { model, ...options } = i
      const out = await call('repair', { mesh: await meshOut(model), options })
      return { summary: 'Repaired the mesh', output: out }
    },
  })

  const hollow = defineTool({
    name: 'geom.hollow',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Hollow a solid model to a shell of a given wall thickness, with optional drain holes so resin or trapped material can leave. Writes a new STL and a volume report.',
    input: z.object({
      model: modelArg,
      wall_mm: z.number().min(0.4).max(50).default(2),
      voxel_mm: z.number().min(0.05).max(5).optional().describe('Grid resolution; smaller is slower and more exact'),
      drain_holes: z.array(z.record(z.string(), z.unknown())).max(8).optional().describe('sx-geom drain hole objects (see the sx-geom README)'),
    }),
    async run(i) {
      const { model, ...options } = i
      const out = await call('hollow', { mesh: await meshOut(model), options })
      return { summary: 'Hollowed the model', output: out }
    },
  })

  const emboss = defineTool({
    name: 'geom.emboss',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Raise (emboss) or cut in (deboss) text on a face of the model. Give the point on the surface where the text is centered, and the face normal if the point is on an edge. Writes a new STL.',
    input: z.object({
      model: modelArg,
      text: z.string().min(1).max(200).describe('Text to place; \\n starts a new line'),
      point: vec3.describe('Center of the text on the surface, mm'),
      normal: vec3.optional(),
      up: vec3.optional().describe('Text up direction; defaults to +Z, or +Y on a horizontal face'),
      size_mm: z.number().positive().max(200).describe('Capital letter height, mm'),
      depth_mm: z.number().positive().max(50).describe('Height of raised text or depth of the pocket, mm'),
      mode: z.enum(['emboss', 'deboss']).default('emboss'),
    }),
    async run(i) {
      const { model, ...spec } = i
      const out = await call('emboss', { mesh: await meshOut(model), spec })
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
    description: `Build a new model from simple solids (boxes, cylinders, prisms), optionally cutting holes with convex cutters. Overlapping solids stay separate shells. Writes an STL and returns its volume, bounds and whether it is watertight. ${solidsHelp}`,
    input: z.object({
      solids: z.array(solid).min(1).max(64),
      subtract: z.array(solid).max(64).optional().describe('Convex cutters removed from every solid: box, cylinder, prism or countersink'),
    }),
    async run(i) {
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
    input: z.object({ model: modelArg, solids: z.array(solid).min(1).max(64) }),
    async run(i) {
      const out = await call('subtract', { mesh: await meshOut(i.model), solids: i.solids })
      return { summary: `Removed ${String(out['removedVolumeMm3'] ?? '?')} mm3`, output: out }
    },
  })

  return [cut, split, orient, repair, hollow, emboss, calibration, resume, layers, build, subtract] as PilotTool<never>[]
}
