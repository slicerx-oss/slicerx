// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// STEP and IGES files for clients: read one with the optional @slicerx/step-reader package, in a worker thread with a deadline,
// a 100 MB input cap and a memory cap, and say what is in it. With output stl or obj the meshes are written to a new
// file under the server's output folder, which every model path check allows, so the mesh tools and slicing take it.
// The reader comes from the folder SLICERX_STEP_READER_DIR names, else the step-reader folder beside the self-contained
// server (the desktop app ships it there), else the installed package.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type * as StepNode from '@slicerx/step-reader/node'
import { productName } from '@slicerx/contracts'
import { resolveModel, ToolInputError } from '../models'
import { planBodyFilaments } from '../body-filaments'
import { filamentColor, MAX_FILAMENTS } from '../filaments'
import { serverTool, type ServerToolDeps } from './deps'

export const STEP_EXTENSIONS = ['.step', '.stp', '.igs', '.iges'] as const
// The reader ships in the integrator kit as its own tarball, beside slicerx-mcp.tgz; ./kit is the kit folder.
const INSTALL = 'npm install ./kit/slicerx-step-reader.tgz'
/** Names a folder holding the built reader (node.js and the files beside it), used before anything else. */
export const STEP_READER_DIR_ENV = 'SLICERX_STEP_READER_DIR'

// true in the self-contained build (scripts/build.mjs --standalone), which has no node_modules to install into.
declare const __SLICERX_STANDALONE__: boolean | undefined
const standalone = typeof __SLICERX_STANDALONE__ === 'boolean' && __SLICERX_STANDALONE__

type StepModule = typeof StepNode

/** The folder the reader came from, or the package; for the refusal when it is missing. */
type Source = { kind: 'env' | 'bundled'; dir: string } | { kind: 'package' }

/** The reader's folder: SLICERX_STEP_READER_DIR, else `bundled` (the step-reader folder beside the server) when it holds one. */
export function stepReaderSource(env: NodeJS.ProcessEnv, bundled: string | undefined): Source {
  const named = env[STEP_READER_DIR_ENV]?.trim()
  if (named) return { kind: 'env', dir: resolve(named) }
  if (bundled && existsSync(join(bundled, 'node.js'))) return { kind: 'bundled', dir: bundled }
  return { kind: 'package' }
}

let lastSource: Source = { kind: 'package' }

/**
 * The reader. `bundled` is the step-reader folder beside the server's entry, which the command line sets
 * (setBundledStepReader). Kept apart so a test can stand in for it.
 */
export const stepModule = {
  bundled: undefined as string | undefined,
  load: (): Promise<StepModule> => {
    const source = (lastSource = stepReaderSource(process.env, stepModule.bundled))
    if (source.kind === 'package') return import('@slicerx/step-reader/node')
    return import(pathToFileURL(join(source.dir, 'node.js')).href) as Promise<StepModule>
  },
}

/** Where the self-contained server ships the reader: a step-reader folder next to its entry file. */
export function setBundledStepReader(dir: string): void {
  stepModule.bundled = dir
}

/**
 * The reader, refusing an IGES file when the installed reader is older than IGES support (it reads STEP only and has no
 * cadFormat), instead of letting it call the file "not a STEP file".
 */
export async function reader(path: string): Promise<StepModule> {
  const step = await load()
  if (/\.(igs|iges)$/i.test(path) && typeof (step as Partial<StepModule>).cadFormat !== 'function') {
    throw new ToolInputError(`The @slicerx/step-reader installed beside this server reads STEP files only. Reading IGES files needs a newer one: install the slicerx-step-reader.tgz from the same kit as this server (${INSTALL}) and start the server again.`, 'not_supported', { install: INSTALL })
  }
  return step
}

async function load(): Promise<StepModule> {
  try {
    return await stepModule.load()
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (module|package) '@slicerx\/step-reader/.test(String((e as Error).message))) {
      if (lastSource.kind === 'env') {
        throw new ToolInputError(`${STEP_READER_DIR_ENV} names ${lastSource.dir}, which holds no STEP reader (node.js from a built @slicerx/step-reader). Point it at that folder, or unset it.`, 'not_supported', { step_reader_dir: lastSource.dir })
      }
      if (standalone) {
        throw new ToolInputError(`This copy of the server was built without the STEP reader, so it cannot read STEP files. Open the file in ${productName()} instead (slicerx_open_in_app), or name a folder holding the reader in ${STEP_READER_DIR_ENV}.`, 'not_supported')
      }
      throw new ToolInputError(`Reading STEP files needs the optional @slicerx/step-reader package, which is not installed next to this server. Install the kit's slicerx-step-reader.tgz beside @slicerx/mcp (${INSTALL}, with ./kit your kit folder) and start the server again.`, 'not_supported', { install: INSTALL })
    }
    throw e
  }
}

const bounds = z.object({ min: z.tuple([z.number(), z.number(), z.number()]), max: z.tuple([z.number(), z.number(), z.number()]) }).nullable()

export const stepReadShape = {
  file: z.string().describe('The STEP or IGES file that was read'),
  unit: z.enum(['millimeter', 'centimeter', 'meter', 'inch', 'foot']).nullable().describe('The length unit the file declares; every size here is in mm'),
  triangles: z.number().int(),
  tolerance_mm: z.number().describe('Chord tolerance the file was meshed at'),
  notes: z.array(z.string()),
  bounds: bounds.describe('Box of every body in mm, centered on the origin'),
  objects: z.array(
    z.object({
      name: z.string(),
      triangles: z.number().int(),
      bounds,
      bodies: z.array(
        z.object({
          name: z.string(),
          color: z.string().nullable().describe('#rrggbb when the file colors this solid'),
          filament: z.number().int().nullable().describe('The filament this body would print with, 1-based; null when it has no color'),
          filament_match: z.enum(['match', 'new', 'nearest']).nullable().describe('match: a filament the project has, close in color; new: one of filaments_to_add; nearest: no close filament and no room for another'),
          triangles: z.number().int(),
          bounds,
        }),
      ),
    }),
  ),
  filaments_to_add: z.array(z.object({ filament: z.number().int(), color: z.string() })).describe('Filaments the colors need that the project does not have, each with its color'),
  output: z.object({ format: z.enum(['stl', 'obj']), path: z.string(), bytes: z.number().int() }).optional().describe('The mesh file written, with output stl or obj'),
}

export default (d: ServerToolDeps) =>
  serverTool({
    name: 'step_read',
    title: 'Read a STEP or IGES file',
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    toolset: 'core',
    ungated: true,
    description:
      `Read a STEP file (.step or .stp; AP203, AP214 or AP242) or an IGES file (.igs or .iges) as ${productName()} reads it: the objects it becomes (touching bodies stay together; an IGES file of loose surfaces and no solids becomes a body per group of touching surfaces), each body's name, color (#rrggbb, or null), the filament it would print with and triangle count, boxes in mm, the unit the file declares and notes. With output "stl" or "obj" it also writes the meshes, in mm, to a new file in the server's output folder and returns its path, which the mesh tools and slicerx_slice_file take; colored bodies keep their color as OBJ vertex colors or STL facet colors. The file is read in a worker with a deadline (a minute plus 2 s per MB), a 100 MB size limit and a memory limit. A refusal has a step_ code: step_empty, step_not_step, step_step_xml, step_not_iges, step_iges_compressed, step_too_large, step_no_solids, step_too_detailed, step_unreadable, step_out_of_memory or step_timeout. Needs the optional @slicerx/step-reader package, the kit's slicerx-step-reader.tgz (${INSTALL}), which the server bundled with the desktop app includes; without it the call is refused with not_supported. Body colors are planned onto filaments as the app does when it opens the file: a color within CIEDE2000 12 of one of the filaments given in filaments (the project's colors, filament 1 first; unset, a new project) prints with it (match), another color gets a filament of its own (new, listed in filaments_to_add) up to max_filaments, and past that the nearest (nearest). Nothing is changed; slicerx_project_add_model applies the plan. To open the file in the app instead, use slicerx_open_in_app.`,
    input: z.object({
      model: z.string().min(1).describe('Absolute path or http(s) URL of a .step, .stp, .igs or .iges file'),
      quality: z.enum(['normal', 'coarser', 'finer']).default('normal').describe('Chord tolerance: coarser 0.05 mm, normal 0.01 mm, finer 0.003 mm'),
      output: z.enum(['none', 'stl', 'obj']).default('none').describe('Also write the meshes to an STL or OBJ file in the output folder'),
      filaments: z.array(z.string().min(6).max(9)).max(MAX_FILAMENTS).optional().describe('Colors (#rrggbb) of the filaments the project has, filament 1 first, to match body colors against; unset, a new project'),
      max_filaments: z.number().int().min(1).max(MAX_FILAMENTS).default(MAX_FILAMENTS).describe("The most filaments the project may have, such as the printer's slot count"),
    }),
    outputShape: stepReadShape,
    hints: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
    async run(args) {
      const path = await resolveModel(d.policy, args.model, STEP_EXTENSIONS)
      let filaments
      try {
        filaments = args.filaments?.map((c) => ({ color: filamentColor(c) }))
      } catch (e) {
        throw new ToolInputError((e as Error).message, 'invalid_input')
      }
      const step = await reader(path)
      const name = basename(path)
      let read
      try {
        read = await step.readStepFileInWorker(path, { name, quality: args.quality, appName: productName() })
      } catch (e) {
        if (e instanceof step.StepError) throw new ToolInputError(`${name} ${e.message}`, `step_${e.code}`, { step_code: e.code })
        throw e
      }
      const info = step.stepInfo(read)
      // each body's filament, planned as the app plans it when it opens the file
      const plan = planBodyFilaments(info.objects.flatMap((o) => o.bodies.map((b) => b.color)), filaments, args.max_filaments)
      let k = 0
      const objects = info.objects.map((o) => ({
        ...o,
        bodies: o.bodies.map(({ triangles, bounds, ...b }) => {
          const pick = plan.picks[k++]
          return { ...b, filament: pick?.slot ?? null, filament_match: pick?.match ?? null, triangles, bounds }
        }),
      }))
      let output: { format: 'stl' | 'obj'; path: string; bytes: number } | undefined
      if (args.output !== 'none') {
        const dir = join(d.policy.outDir, 'step', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
        mkdirSync(dir, { recursive: true })
        const file = join(dir, `${basename(name, extname(name)).replace(/[^\w.\- ]+/g, '_') || 'model'}.${args.output}`)
        const bytes = args.output === 'stl' ? step.toStl(read) : new TextEncoder().encode(step.toObj(read))
        writeFileSync(file, bytes)
        output = { format: args.output, path: file, bytes: bytes.length }
      }
      const structured = {
        file: path,
        unit: info.unit,
        triangles: info.triangles,
        tolerance_mm: info.toleranceMm,
        notes: info.notes,
        bounds: info.bounds,
        objects,
        filaments_to_add: plan.add.map((a) => ({ filament: a.slot, color: a.color })),
        ...(output ? { output } : {}),
      }
      const bodies = info.objects.reduce((n, o) => n + o.bodies.length, 0)
      const summary = `${name}: ${info.objects.length} ${info.objects.length === 1 ? 'object' : 'objects'}, ${bodies} ${bodies === 1 ? 'body' : 'bodies'}, ${info.triangles.toLocaleString('en-US')} triangles${plan.add.length ? `; its colors need ${plan.add.length} more ${plan.add.length === 1 ? 'filament' : 'filaments'}` : ''}${output ? `; wrote ${output.path}` : ''}.`
      return { summary, structured }
    },
  })
