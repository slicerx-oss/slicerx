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
import type { DesignHost } from '@slicerx/cad-history'
import { productName } from '@slicerx/contracts'
import { modelingTools } from './modeling-tools'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import { findBinary } from './sx'
import { looksZipped, refuseVaultFile } from './vault'
import { modelArg, vec3, type GeomCall } from './args'
import type { CadFiles } from './cad'
import { readStlPositions } from './mesh'

export { modelArg, vec3, type GeomCall }

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
      if (child.killed) {
        const error = new Error(`sx-geom ${op} exceeded its execution deadline (${timeoutMs} ms). Retry the operation.`)
        error.name = 'AbortError'
        return reject(error)
      }
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

/** The CAD tools' files on this server: the sx-geom program on STL files, model paths from the policy. */
export function cadFiles(deps: GeomToolDeps): CadFiles {
  return { engine: Boolean(deps.bin), call: geomCaller(deps), path: (model) => resolveModel(deps.policy, model), stl: (stlPath) => readStlPositions(readFileSync(stlPath)) }
}

/** The engine as a history replay calls it: JSON in, meshes back as numbers (with their faces), no files. */
export function geomEngine(bin: string, timeoutMs = 5 * 60_000): (op: string, request: unknown) => Promise<unknown> {
  return (op, request) => runGeom(bin, op, request, undefined, timeoutMs)
}

export function geomTools(deps: GeomToolDeps & { designs?: DesignHost | undefined }): PilotTool<never>[] {
  const call = geomCaller(deps)
  // sx-geom reads STL only; a 3MF would be read as a binary STL with nonsense counts.
  const stlOnly = (path: string): { stlPath: string } => {
    if (extname(path).toLowerCase() !== '.stl' || looksZipped(path)) {
      throw new ToolInputError(`${basename(path)} is not an STL. The mesh tools take STL files only; to work on a 3MF, export the object as STL from ${productName()} first.`, 'unsupported_format')
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

  return [...modelingTools({ files: { call, mesh: meshOut }, designs: deps.designs }), orient, calibration, resume, layers, render, paintRegions] as PilotTool<never>[]
}
