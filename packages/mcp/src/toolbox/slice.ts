// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing one file or one plate of a project, shared by slicerx_slice_file and slicerx_estimate_file.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { gcodeLabel, printerForProfile } from '@slicerx/settings'
import type { ToolOutput } from '@slicerx/pilot'
import { z } from 'zod'
import { isGcodeKey, resolveSliceConfig, SHIPPED_GCODE_SOURCES, type ExtraLayers, type SlotLayer } from '../config'
import { gcode3mf, PLATE_THUMBNAILS } from '../gcode3mf'
import { resolveModel, ToolInputError } from '../models'
import { readPresetFiles } from '../presets'
import { importReportLines, readProjectFile, sliceWalls, type WallsNote } from '../projectfile'
import { toSchemaValue } from '../settings'
import type { SliceSummary } from '../slicer'
import type { ServerToolDeps } from './deps'

export const settingValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.unknown())])
const overridesSchema = z
  .record(z.string(), settingValue)
  .describe('OrcaSlicer setting keys to values, applied last. Example: {"layer_height": 0.16, "sparse_infill_density": 25, "enable_support": true}')

export const sliceInput = {
  model: z.string().min(1).describe('Absolute path to an STL, OBJ, 3MF or .sx3mf file, an http(s) URL to download one, or a built-in test model: sample:cube-20, sample:tower-20x60, sample:plate-60x40x3 or sample:x-mark (the SlicerX X mark)'),
  plate: z.number().int().min(1).max(999).optional().describe('For a 3MF or .sx3mf project, the plate to slice (1-based, see slicerx_inspect_project). Default: the first plate.'),
  project_settings: z
    .boolean()
    .default(false)
    .describe("Start from the 3MF or .sx3mf project's own print settings (as saved by Bambu Studio, OrcaSlicer or SlicerX), then apply profiles, profile_files and overrides on top"),
  project_gcode: z
    .enum(['review', 'profile'])
    .default('review')
    .describe(
      "With project_settings: what to do with the project's printer G-code (start, end, layer change and the rest) when it is not the printer's stock text. review (the default): refuse with error code project_gcode_review, a one-line details.summary to show first and the diff and flagged lines in structuredContent.error.details, for the person to see; printer_needed when no printer profile names the printer to compare with. profile: slice with the printer profile's G-code instead. Stock text is always used as it is. Only a person can choose a project's own G-code, in SlicerX; no tool call can.",
    ),
  paint: z
    .record(z.string().regex(/^\d+$/), z.partialRecord(z.enum(['color', 'seam', 'support', 'fuzzy']), z.record(z.string().regex(/^\d+$/), z.string().max(4096))))
    .optional()
    .describe(
      'Paint written over the model\'s own before slicing, in the shape the app saves: { "<part index>": { "color" | "seam" | "support" | "fuzzy": { "<triangle index>": "<paint text>" } } }, texts as a 3MF\'s per-triangle paint (for color, state n is filament slot n; an empty text clears the triangle). One object only.',
    ),
  strict_settings: z
    .boolean()
    .default(false)
    .describe("With project_settings: refuse with error code project_settings_unused when the project's print settings carry keys SlicerX does not know or values it cannot read, instead of slicing without them (import_report lists them either way)"),
  allow_collisions: z
    .boolean()
    .default(false)
    .describe('Slice even when paths cross, enter a keep-out zone or would meet the toolhead. Leave it off unless the person asked: by default such a plate is refused with error code collision (or sequence_clearance when printing by object), the objects and layers in structuredContent.error.details.'),
  profiles: z
    .array(z.string())
    .max(8)
    .default([])
    .describe('Profiles applied in order, by id or name from slicerx_list_profiles. Example: ["machine:bambu-a1", "stock-filament:BBL/Bambu PLA Basic @BBL A1", "process:standard"]'),
  profile_files: z
    .array(z.string())
    .max(16)
    .default([])
    .describe("The user's own OrcaSlicer or Bambu Studio presets: absolute paths to preset .json files or preset bundles (.bbscfg, .bbsflmt, .orca_printer, .orca_filament, .zip). Applied after profiles: printer, then process, then filament."),
  filaments: z
    .array(
      z.object({
        slot: z.number().int().min(1).max(16).describe('Filament slot, 1-based: the extruder or AMS slot the project assigns objects to'),
        profile: z.string().optional().describe('A filament profile id from slicerx_list_profiles, such as "stock-filament:BBL/Bambu PETG HF @BBL A1"'),
        file: z.string().optional().describe("Absolute path of the user's own filament preset (.json, .bbsflmt or .orca_filament)"),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('The spool color as #RRGGBB, shown by the printer and written to the .gcode.3mf'),
      }),
    )
    .max(16)
    .optional()
    .describe('A filament per slot, for multi-material plates: each entry sets only its own slot. Applied after profile_files and before overrides. Each entry names a profile or a file, or only a color.'),
  overrides: overridesSchema.optional(),
}

export const sliceFileInput = {
  ...sliceInput,
  output: z.enum(['gcode', 'gcode.3mf']).default('gcode').describe('gcode: a plain G-code file. gcode.3mf: also a .gcode.3mf holding the plate, the format Bambu Lab printers print'),
  preview: z.boolean().default(false).describe('Also write the toolpath preview (SXPV) that the @slicerx/embed viewport shows. sx engine only.'),
}

export const summaryShape = {
  engine: z.enum(['sx', 'stub']),
  model: z.object({ name: z.string(), triangles: z.number().optional(), bbox_mm: z.array(z.number()).optional() }),
  layer_count: z.number(),
  time_s: z.number(),
  time_text: z.string(),
  filament_g: z.number(),
  filament_mm: z.number(),
  filaments: z.array(z.object({ slot: z.number(), filament_mm: z.number(), filament_g: z.number() })),
  tool_changes: z.number().optional(),
  plate: z.number().optional(),
  gcode_path: z.string().optional(),
  gcode_sha256: z.string().optional(),
  gcode_3mf_path: z.string().optional(),
  preview_path: z.string().optional(),
  applied: z.array(z.string()),
  /** How the project's own printer G-code was used (project_settings). */
  project_gcode: z.array(z.object({ key: z.string(), slot: z.number().optional(), use: z.enum(['project', 'profile']), message: z.string() })).optional(),
  warnings: z.array(z.string()),
  /** With project_settings: what the project's print settings carry that slicing did not use, by kind. */
  import_report: z
    .object({
      source: z.string().optional(),
      unknown: z.array(z.object({ key: z.string(), value: z.unknown() })),
      retired: z.array(z.string()),
      other_slicer: z.array(z.string()),
      renamed: z.array(z.object({ from: z.string(), to: z.string() })),
      invalid: z.array(z.object({ key: z.string(), value: z.unknown() })),
      walls: z.object({ generator: z.string(), source: z.enum(['kept', 'project', 'request', 'profile']), text: z.string() }).optional(),
    })
    .optional(),
  /** Which wall generator the slice ran and why. */
  walls: z.object({ generator: z.string(), source: z.enum(['kept', 'project', 'request', 'profile']), text: z.string() }).optional(),
  /** Warnings with a code an app can act on, each also in `warnings`: `no_printer` when no printer was named. */
  notices: z.array(z.object({ code: z.enum(['no_printer']), message: z.string() })).optional(),
  note: z.string().optional(),
}

/** The warning for a slice that named no printer, with the size of the generic bed the engine used. */
export function noPrinterMessage(config: Record<string, unknown>): string {
  const pts = (Array.isArray(config['printable_area']) ? config['printable_area'] : [])
    .map((p) => (Array.isArray(p) ? p.map(Number) : String(p).split('x').map(Number)))
    .filter((p): p is number[] => p.length === 2 && p.every(Number.isFinite))
  const span = (i: number) => (pts.length ? Math.round(Math.max(...pts.map((p) => p[i]!)) - Math.min(...pts.map((p) => p[i]!))) : 0)
  const [w, d] = [span(0), span(1)]
  const size = w > 0 && d > 0 ? (w === d ? `${w} mm` : `${w} by ${d} mm`) : ''
  return `No printer chosen, so this slice used a generic ${size ? `${size} ` : ''}machine; times and limits are not for your printer.`
}

export type SlotArg = { slot: number; profile?: string | undefined; file?: string | undefined; color?: string | undefined }
export type SliceArgs = { model: string; plate?: number | undefined; project_settings: boolean; strict_settings?: boolean; project_gcode: 'review' | 'profile'; allow_collisions?: boolean; paint?: Record<string, Record<string, Record<string, string>>> | undefined; profiles: string[]; profile_files: string[]; filaments?: SlotArg[] | undefined; overrides?: Record<string, unknown> | undefined; output?: 'gcode' | 'gcode.3mf'; preview?: boolean }

/** The filament of each slot entry, as a layer for resolveSliceConfig. Profiles must be prepared first. */
async function slotLayers(d: ServerToolDeps, slots: SlotArg[]): Promise<SlotLayer[]> {
  const { profiles } = d
  const seen = new Set<number>()
  const out: SlotLayer[] = []
  for (const s of slots) {
    if (seen.has(s.slot)) throw new ToolInputError(`filaments names slot ${s.slot} twice`, 'invalid_input')
    seen.add(s.slot)
    if (s.profile && s.file) throw new ToolInputError(`filaments slot ${s.slot}: give a profile or a file, not both`, 'invalid_input')
    if (!s.profile && !s.file && !s.color) throw new ToolInputError(`filaments slot ${s.slot}: give a profile, a file or a color`, 'invalid_input')
    if (s.profile) {
      const p = profiles.get(s.profile)
      if (!p) throw new ToolInputError(`No profile "${s.profile}". Use slicerx_list_profiles with section "filament" to find one.`, 'unknown_profile')
      if (p.section !== 'filament') throw new ToolInputError(`filaments slot ${s.slot}: ${p.id} is a ${p.section} profile, not a filament`, 'invalid_input')
      out.push({ slot: s.slot, name: p.id, values: p.config, color: s.color, customGcode: !SHIPPED_GCODE_SOURCES.has(p.source) && Object.keys(p.config).some(isGcodeKey) })
    } else if (s.file) {
      const layer = (await readPresetFiles(d.policy, [s.file])).find((l) => l.section === 'filament')
      if (!layer) throw new ToolInputError(`filaments slot ${s.slot}: ${basename(s.file)} holds no filament preset`, 'invalid_input')
      out.push({ slot: s.slot, name: `filament-file:${layer.name}`, values: layer.values, color: s.color, customGcode: layer.customGcode })
    } else {
      out.push({ slot: s.slot, name: `color ${s.color}`, values: {}, color: s.color, customGcode: false })
    }
  }
  return out
}

/**
 * Slices (or only estimates, without `emitGcode`) and answers with the summary and its lines of text. Coarse stages go
 * to `progress`, which the server sends as MCP progress notifications when the client asked for them.
 */
export async function runSlice(d: ServerToolDeps, args: SliceArgs, emitGcode: boolean, report: (message: string, fraction: number) => void): Promise<ToolOutput> {
  const { store, profiles } = d
  const progress = async (p: number, message: string): Promise<void> => report(message, p)
  if (!d.slicer) throw new ToolInputError(d.slicerUnavailable ?? 'No slicing engine is available.', 'engine_unavailable')
  const slicer = d.slicer
  const asked3mf = emitGcode && args.output === 'gcode.3mf'
  if (asked3mf && slicer.kind === 'stub') throw new ToolInputError('The stub engine writes no printable G-code, so it cannot make a .gcode.3mf. Install the sx CLI (docs/install.md).', 'engine_unavailable')
  await progress(0, 'Reading the model')
  const modelPath = await resolveModel(d.policy, args.model)
  const isProject = ['.3mf', '.sx3mf'].includes(extname(modelPath).toLowerCase())
  if ((args.plate !== undefined || args.project_settings) && !isProject) throw new ToolInputError(`${basename(modelPath)} is not a 3MF or .sx3mf project, so it has no plates or project settings`, 'invalid_input')
  let project: ExtraLayers['project']
  let importReport: ReturnType<typeof readProjectFile>['summary']['import_report'] | undefined
  if (isProject && (args.project_settings || args.plate !== undefined)) {
    const read = readProjectFile(modelPath)
    if (args.project_settings) {
      importReport = read.summary.import_report
      const r = importReport
      if (args.strict_settings && (r.unknown.length || r.invalid.length)) {
        throw new ToolInputError(`${basename(modelPath)}'s print settings carry what SlicerX cannot use (strict_settings): ${importReportLines(r).join('; ')}`, 'project_settings_unused')
      }
    }
    if (args.plate !== undefined && !read.summary.plates.some((p) => p.index === args.plate)) {
      throw new ToolInputError(`${basename(modelPath)} has no plate ${args.plate}. Plates: ${read.summary.plates.map((p) => p.index).join(', ')}.`, 'no_such_plate')
    }
    // Bambu Studio and Orca keep a print sequence per plate, over the project's.
    const seq = (read.summary.plates.find((p) => p.index === args.plate) ?? read.summary.plates[0])?.print_sequence
    const printer = read.summary.presets.printer ? printerForProfile(read.summary.presets.printer)?.printerId : undefined
    if (args.project_settings) project = { name: basename(modelPath), config: { ...read.config, ...(seq ? { print_sequence: seq } : {}) }, model: printer, gcode: args.project_gcode }
  }
  await progress(0.1, 'Resolving settings')
  await profiles.prepare([...args.profiles, ...(args.filaments ?? []).flatMap((s) => (s.profile ? [s.profile] : []))])
  const presets = args.profile_files.length ? await readPresetFiles(d.policy, args.profile_files) : undefined
  const slots = args.filaments?.length ? await slotLayers(d, args.filaments) : undefined
  const { config, explicit, applied, trustedGcode, gcodeKept, gcodeReplaced, noPrinter } = resolveSliceConfig(store, profiles, args.profiles, args.overrides, { project, presets, slots })
  const projectGcode = [
    ...gcodeKept.map((k) => ({ key: k.key, ...(k.slot !== undefined ? { slot: k.slot } : {}), use: 'project' as const, message: `The project's ${k.label} ${k.message}.` })),
    ...gcodeReplaced.map((k) => ({ key: k, use: 'profile' as const, message: `Used the printer profile's ${gcodeLabel(k)} instead of the project's.` })),
  ]
  // A .gcode.3mf carries the plate picture: ask the engine to draw one when the settings name no thumbnail sizes.
  if (asked3mf && explicit['thumbnails'] === undefined) explicit['thumbnails'] = config['thumbnails'] = PLATE_THUMBNAILS
  await progress(0.2, 'Slicing')
  const outDir = join(d.policy.outDir, 'jobs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  const result: SliceSummary = await slicer.slice({
    modelPath,
    ...(args.plate !== undefined ? { modelPlate: args.plate } : {}),
    config,
    explicitConfig: explicit,
    profileNames: args.profiles,
    overrides: Object.fromEntries(Object.entries(args.overrides ?? {}).map(([k, v]) => [k, toSchemaValue(store.setting(k), v)])),
    outDir,
    emitGcode,
    trustedGcode,
    emitPreview: emitGcode && args.preview === true && slicer.kind === 'sx',
    ...(args.allow_collisions ? { allowCollisions: true } : {}),
    ...(args.paint ? { paint: args.paint } : {}),
  })
  if (asked3mf && result.gcode_path) {
    await progress(0.9, 'Writing the .gcode.3mf')
    const path = join(outDir, `${basename(modelPath, extname(modelPath))}${args.plate ? `-plate${args.plate}` : ''}.gcode.3mf`)
    writeFileSync(path, gcode3mf(readFileSync(result.gcode_path, 'utf8'), result, config))
    result.gcode_3mf_path = path
  }
  await progress(1, 'Done')
  const walls: WallsNote = sliceWalls(config['wall_generator'], args.overrides, importReport?.walls)
  const notices = noPrinter ? [{ code: 'no_printer' as const, message: noPrinterMessage(config) }] : []
  for (const n of notices) result.warnings.push(n.message)
  const lines = [
    `${result.model.name}${result.plate ? `, plate ${result.plate}` : ''}: ${result.layer_count} layers, ${result.time_text}, ${result.filament_g} g (${(result.filament_mm / 1000).toFixed(2)} m) [engine ${result.engine}]`,
    ...(result.filaments.length > 1 ? [`Filaments: ${result.filaments.map((f) => `slot ${f.slot} ${f.filament_g} g`).join(', ')}`] : []),
    ...(applied.length ? [`Profiles: ${applied.join(', ')}`] : []),
    ...(result.gcode_path ? [`G-code: ${result.gcode_path}`] : []),
    ...(result.gcode_3mf_path ? [`G-code 3MF: ${result.gcode_3mf_path}`] : []),
    ...(result.preview_path ? [`Preview: ${result.preview_path}`] : []),
    `Walls: ${walls.text}`,
    ...result.warnings.map((w) => `Warning: ${w}`),
    ...(importReport ? importReportLines(importReport, false).map((l) => `Project settings: ${l}`) : []),
    ...(result.note ? [result.note] : []),
  ]
  return { summary: lines[0] ?? 'Sliced', structured: { ...result, applied, ...(projectGcode.length ? { project_gcode: projectGcode } : {}), ...(notices.length ? { notices } : {}), ...(importReport ? { import_report: importReport } : {}), walls }, text: [...lines, ...projectGcode.map((g) => g.message)].join('\n') }
}

