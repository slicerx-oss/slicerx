// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Slicing one file or one plate of a project, shared by slicerx_slice_file and slicerx_estimate_file.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { BED_TYPE_OPTIONS, bedTypeByName, gcodeLabel, printerForProfile, printerProfile, type BedType } from '@slicerx/settings'
import type { ToolOutput } from '@slicerx/pilot'
import { z } from 'zod'
import { COLOR_SLOT_MAX, productName, type ScriptReplacementChoice } from '@slicerx/contracts'
import { isGcodeKey, resolveSliceConfig, SHIPPED_GCODE_SOURCES, slicePrinter, type ExtraLayers, type SlotLayer } from '../config'
import { gcode3mf, PLATE_THUMBNAILS } from '../gcode3mf'
import { resolveModel, ToolInputError } from '../models'
import { vaultMark } from '../vault'
import { readPresetFiles } from '../presets'
import { importReportLines, objectLayerHeights, readProjectFile, sliceWalls, type WallsNote } from '../projectfile'
import { openProject, projectPrinterUse } from '../project-open'
import { toSchemaValue } from '../settings'
import { reviewProjectScripts } from '../project-script-review'
import { replacementConfig } from '../script-replacement'
import type { Arranged, SliceJob, SliceSummary } from '../slicer'
import type { ServerToolDeps } from './deps'
import { ignoredArgumentsMessage } from '../ignored-arguments'

const CHAMBER_KEY = 'chamber_cooling_mode'

export const settingValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.unknown())])
const overridesSchema = z
  .record(z.string(), settingValue)
  .describe('Setting keys to values, applied last. Example: {"layer_height": 0.16, "sparse_infill_density": 25, "enable_support": true}')

export const sliceInput = {
  script_replacements: z.array(z.object({ key: z.string().min(1), slot: z.number().int().min(0).max(63).optional(), original: z.string().max(1_048_576), replacement: z.string().max(1_048_576) })).min(1).max(64).optional().describe('Explicit choices to replace imported script slots with verified stock. Requires project_settings, project_gcode review and script_printer. Supply exact original text from inspection and the chosen stock text. The engine rechecks identity and text, retains originals in script_replacements, and never starts a printer.'),
  script_printer: z.object({ model: z.string().min(1), firmware: z.string().min(1) }).optional().describe('Explicit target model id and firmware for comparing imported scripts with known stock, without replacing project settings. Conflicting project identity or changed executable text still requires review.'),
  model: z.string().min(1).describe('Absolute path to an STL, OBJ, 3MF or .sx3mf file, an http(s) URL to download one, or a built-in test model: sample:cube-20, sample:tower-20x60, sample:plate-60x40x3 or sample:x-mark (an X mark)'),
  plate: z.number().int().min(1).max(999).optional().describe('For a 3MF or .sx3mf project, the plate to slice (1-based, see slicerx_inspect_project). Default: the first plate.'),
  plate_type: z.string().max(64).optional().describe(`The build plate the print goes on, which sets the bed temperatures: ${BED_TYPE_OPTIONS.map((o) => o.label).join(', ')}, as the app names them, in any letter case. It goes over the plate type a project, its plate or a profile sets. Leave it out to keep the plate type the settings give.`),
  placement: z
    .enum(['center', 'keep', 'arrange'])
    .default('center')
    .describe("Where a 3MF's parts go on the bed. center (the default): the plate centered on the bed as a whole, each part keeping its place to the others; a Bambu Studio, OrcaSlicer or PrusaSlicer project keeps its own positions. keep: each part where the file's build transform puts it, from the front left corner of the printable area, with no recentering; a part that lands off the printable area is refused with invalid_input (details.reason off_bed), the message naming the part and how far it hangs over each edge in mm. arrange: the engine packs every part of the plate on the printer's bed first, as slicerx_arrange_file does (clear of the printer's keep-out zones such as the A1's nozzle wrap check corner, the extruder clearance apart when the plate prints by object, 6 mm apart by layer); the result's arranged gives the layout, and a plate whose parts do not all fit is refused with invalid_input (details.reason no_room, details.not_fit the part names). An STL or OBJ has no placement of its own and is centered under center and keep. sx engine only."),
  project_settings: z
    .boolean()
    .default(false)
    .describe("Start from the 3MF or .sx3mf project's own print settings (as saved by Bambu Studio, OrcaSlicer or this app), then apply profiles, profile_files and overrides on top. With a machine: profile in profiles, another slicer's 3MF opens on that printer the way the app opens it instead: the printer's machine, process and filament settings, then the project's settings over them, then the other profiles, profile_files and overrides."),
  project_gcode: z
    .enum(['review', 'profile'])
    .default('review')
    .describe(
      "With project_settings: what to do with the project's printer G-code (start, end, layer change and the rest) when it is not the printer's stock text. review (the default): refuse with error code project_gcode_review, a one-line details.summary to show first and the diff and flagged lines in structuredContent.error.details, for the person to see; printer_needed when no printer profile names the printer to compare with. profile: slice with the printer profile's G-code instead. Stock text is always used as it is. With a machine: profile for another printer than the project's, or for a PrusaSlicer project, the project's G-code is not used: the slice takes that printer's, as the app does. Only a person can choose a project's own G-code, in the app; no tool call can.",
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
    .describe("With project_settings: refuse with error code project_settings_unused when the project's print settings carry keys the slicer does not know or values it cannot read, or its settings file cannot be read at all, instead of slicing without them (import_report lists them either way)"),
  allow_collisions: z
    .boolean()
    .default(false)
    .describe('Slice even when paths cross, enter a keep-out zone or would meet the toolhead. Leave it off unless the person asked: by default such a plate is refused with error code collision (or sequence_clearance when printing by object), the objects and layers in structuredContent.error.details, and each collision with its part struck and place in details.collision_list. Sliced anyway, the result lists them in collisions.'),
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
        slot: z.number().int().min(1).max(COLOR_SLOT_MAX).describe('Filament slot, 1-based: the extruder or AMS slot the project assigns objects to'),
        profile: z.string().optional().describe('A filament profile id from slicerx_list_profiles, such as "stock-filament:BBL/Bambu PETG HF @BBL A1"'),
        file: z.string().optional().describe("Absolute path of the user's own filament preset (.json, .bbsflmt or .orca_filament)"),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe('The spool color as #RRGGBB, shown by the printer and written to the .gcode.3mf'),
      }),
    )
    .max(COLOR_SLOT_MAX)
    .optional()
    .describe('A filament per slot, for multi-material plates: each entry sets only its own slot. Applied after profile_files and before overrides. Each entry names a profile or a file, or only a color.'),
  overrides: overridesSchema.optional(),
}

/** What slicerx_arrange_file takes: the slice inputs without placement, plus the arrange's own. */
const { placement: _placement, plate_type: _plateType, ...arrangeBase } = sliceInput
export const arrangeInput = {
  ...arrangeBase,
  spacing_mm: z.number().min(0).max(50).optional().describe('Space between parts and from the bed edge, mm (default 6). Printing by object the parts keep the extruder clearance apart whatever this says.'),
  rotate: z.boolean().default(true).describe('Let a part turn about Z where that packs better (default true). Each part keeps its own rotation and scale either way.'),
  step_deg: z.number().min(1).max(90).optional().describe('The turn step while rotate is on, degrees (default 10), as the app\'s Arrange options give it.'),
  effort: z.enum(['quick', 'normal', 'thorough']).optional().describe('How long the arrange searches for a fuller layout (default normal). Counted work, not time, so the same plate gives the same layout on any machine.'),
  keep: z.array(z.string().min(1)).max(500).optional().describe("Ids of parts (objects[].id of an earlier call) that stay where the plate puts them; the others are packed round them, as the app's Arrange selection does. A kept part is not listed in objects. An id the plate does not have is refused."),
  new_plates: z.boolean().optional().describe("Lay the parts with no room out on new, empty plates too, in the same call, as the app's Arrange moves them to new plates: plates lists each one's parts, each plate as an arrange of the parts still left lays it out. not_fit still names every part with no room on this plate."),
}

export const sliceFileInput = {
  ...sliceInput,
  output: z.enum(['gcode', 'gcode.3mf']).default('gcode').describe('gcode: a plain G-code file. gcode.3mf: also a .gcode.3mf holding the plate, the format Bambu Lab printers print. For a Vault design it holds no mesh: the G-code, the objects the printer can skip and the listing'),
  preview: z.boolean().default(false).describe('Also write the toolpath preview (SXPV) that the @slicerx/embed viewport shows. sx engine only.'),
  preview_format: z.enum(['v1', 'v2']).default('v1').describe('The encoding of the preview: v1, the fixed-size records every SXPV reader reads, or v2, the same toolpaths in about a fifth of the bytes, layer by layer, which readPreview in @slicerx/contracts and @slicerx/embed expands. v1 stays the default until a later release.'),
}

const v3 = z.tuple([z.number(), z.number(), z.number()])

/** A plate's layout as the engine's arrange gives it (slicerx_arrange_file, and a slice with placement arrange). */
export const arrangedShape = {
  by_object: z.boolean().describe('The plate prints by object, so its parts keep the extruder clearance apart'),
  spacing_mm: z.number().describe('Space between parts and from the bed edge, mm'),
  clearance_mm: z.number().optional().describe('Printing by object: the extruder clearance radius the parts keep apart, mm'),
  rotate: z.boolean(),
  lanes: z.boolean().describe('Printing by object: the parts taller than the gantry rod went in lanes of their own across the bed'),
  keep_out: z.array(z.string()).describe('What the layout keeps clear of besides the bed edge: exclusion-area, wrap-check-zone, prime-tower'),
  fits: z.boolean().describe('Every part found room'),
  objects: z.array(z.object({
    id: z.string().describe('The engine object id'),
    name: z.string(),
    center_mm: z.tuple([z.number(), z.number()]).describe('The middle of its footprint, bed mm'),
    turn_deg: z.number().describe('How far the arrange turned it about Z, after its own rotation, degrees'),
    transform: z.array(z.number()).describe('Its new 4x4 transform, column-major, bed mm'),
  })),
  not_fit: z.array(z.object({ id: z.string(), name: z.string(), reason: z.enum(['no_room', 'too_large']) })).describe('Parts with no room: no_room beside the others, too_large even on an empty bed. They are never overlapped.'),
  order: z.array(z.string()).optional().describe('Printing by object: the print order the layout takes (object ids) when it is not the plate\'s own, so a part taller than the gantry rod prints after the low ones under its gantry; a slice with placement arrange prints in it'),
  check: z.unknown().optional().describe("Printing by object: heimdall's plate check of the layout (as sx check gives it), when every part fits"),
  plates: z.array(z.object({
    objects: z.array(z.object({ id: z.string(), name: z.string(), center_mm: z.tuple([z.number(), z.number()]), turn_deg: z.number(), transform: z.array(z.number()) })),
    order: z.array(z.string()).optional(),
  })).optional().describe('With new_plates: the parts with no room laid out on new plates, in order, each with its parts as objects gives them (and its print order by object). A part no plate takes stays in not_fit only.'),
}

/** A collision as the slice tools answer it (collide.ts SliceCollision): plate mm, layers from 1. */
export const collisionShape = z.object({
  index: z.number().describe('Its place in the list, for slicerx_app_collision_show'),
  kind: z.string().describe('gantry, hotend, nozzle_travel_through_part, tool_change, dock, path_conflict or keep_out'),
  severity: z.enum(['hit', 'close']).describe('hit blocks the print; close is only inside the clearance radius of the profile'),
  part: z.string().describe('The piece of the machine: nozzle, toolhead, gantry, lid or clearance'),
  object_id: z.string().describe('The object printing: the id the request gave the plate object, when it gave one'),
  object_name: z.string().optional(),
  hit_id: z.string().describe('What it meets: an object id, prime-tower, exclusion-area or wrap-check-zone'),
  hit_kind: z.enum(['object', 'tower', 'zone']),
  damaged_id: z.string().optional().describe('The object whose material is struck'),
  first_layer: z.number(),
  last_layer: z.number(),
  time_s: z.number().describe('When it first happens in the print'),
  contact_point: v3.describe('Where it goes deepest, plate mm from the front left corner of the printable area'),
  contact_box: z.object({ min: v3, max: v3 }).optional().describe('The region struck, plate mm; move the struck object or the one printing out of it'),
  depth_mm: z.number(),
  push_mm: z.number().optional().describe('The extra spacing that clears a toolhead strike sideways'),
  limit_mm: z.number().optional().describe('The clearance it breaks: rod or lid height, or the clearance radius'),
})

export const summaryShape = {
  arranged: z.object(arrangedShape).optional().describe('With placement arrange: the layout the slice used'),
  collisions: z.array(collisionShape).optional().describe('sx engine: every collision of the plate, sliced with allow_collisions or as close calls that pass'),
  script_replacements: z.array(z.object({
    schemaVersion: z.literal(1), decision: z.literal('applied'), reason: z.string(),
    key: z.string(), slot: z.number().nullable(), original: z.string(), replacement: z.string(),
    originalFingerprint: z.string(), replacementFingerprint: z.string(),
    originalReview: z.object({ schemaVersion: z.literal(1), decision: z.enum(['exact', 'cosmetic', 'review']), reason: z.string(), identity: z.object({ model: z.string(), firmware: z.string() }).nullable(), source: z.string().nullable(), stockVersion: z.string().nullable(), fingerprint: z.string().nullable(), ignored: z.array(z.string()) }),
    stockReview: z.object({ schemaVersion: z.literal(1), decision: z.enum(['exact', 'cosmetic', 'review']), reason: z.string(), identity: z.object({ model: z.string(), firmware: z.string() }).nullable(), source: z.string().nullable(), stockVersion: z.string().nullable(), fingerprint: z.string().nullable(), ignored: z.array(z.string()) }),
    diff: z.array(z.object({ operation: z.enum(['equal', 'remove', 'add']), originalLine: z.number().nullable(), replacementLine: z.number().nullable(), text: z.string() })),
  })).optional(),
  script_reviews: z.array(z.object({
    key: z.string(), slot: z.number().optional(), schemaVersion: z.literal(1),
    decision: z.enum(['exact', 'cosmetic', 'review']), reason: z.string(),
    identity: z.object({ model: z.string(), firmware: z.string() }).nullable(),
    source: z.string().nullable(), stockVersion: z.string().nullable(), fingerprint: z.string().nullable(),
    ignored: z.array(z.string()),
  })).optional(),
  engine: z.enum(['sx', 'stub']),
  model: z.object({ name: z.string(), triangles: z.number().optional(), bbox_mm: z.array(z.number()).optional() }),
  layer_count: z.number(),
  time_s: z.number(),
  time_text: z.string(),
  filament_g: z.number(),
  filament_mm: z.number(),
  filaments: z.array(z.object({ slot: z.number(), filament_mm: z.number(), filament_g: z.number() })),
  tool_changes: z.number().optional(),
  /** sx engine: the filaments each object's features printed with (outerWall, sparseInfill, support and the rest), slots 1-based. */
  feature_filaments: z.array(z.object({
    object: z.string().optional().describe('The request object id, when the request supplied one'),
    engine_object: z.string().optional().describe('Unique engine object id within this slice, including objects expanded from one file; not a persistent project id'),
    name: z.string(),
    features: z.record(z.string(), z.array(z.number())),
    nozzle_mm: z.number().optional().describe('The size of the nozzle the object printed with, mm, when the nozzles differ in size'),
  })).optional(),
  /** sx engine: the chamber cooling mode the printer's G-code reads (chamber_cooling_mode), when it reads one. */
  chamber_cooling: z.object({
    mode: z.number().describe('0 keep warm (internal circulation), 1 weak cooling, 2 strong cooling (external circulation)'),
    source: z.enum(['override', 'project', 'preset', 'derived', 'config']).describe("override: the overrides of this call; project: the project's settings; preset: a profile, preset file or filament slot; derived: from the filament types the plate prints"),
    filaments: z.array(z.string()).optional().describe('With derived: the filament_type of each filament the plate prints, in slot order'),
    text: z.string(),
  }).optional(),
  /** sx engine: which extruder and hotend each filament printed on, when the printer has a filament map (H2D, H2C, H3C). */
  filament_map: z.object({
    extruders: z.array(z.number()).describe('The extruder of each filament (index slot - 1), from 1'),
    nozzles: z.array(z.number()).describe('The nozzle or hotend of each filament (index slot - 1), from 0'),
    auto: z.boolean().describe('True when the slicer picked the map, false when the settings gave it'),
  }).optional(),
  /** sx engine, on a printer whose hotends are its tools (the H3C): each filament the plate printed with on its tool. */
  hotends: z.object({
    auto: z.boolean().describe('True when the slicer picked the tools, false when the settings gave them (filament_map_mode Manual with filament_nozzle_map)'),
    filaments: z.array(z.object({
      slot: z.number().describe('The filament, from 1'),
      tool: z.number().describe('The tool as the printer and the app number it, from 1'),
      hotend: z.number().describe('The hotend index the engine and the G-code use, from 0'),
      tpu_tool: z.boolean().describe('The tool is the TPU hotend, the one for 2.85 mm TPU'),
      tpu285: z.boolean().describe('The filament is 2.85 mm TPU'),
    })),
  }).optional().describe('On a printer whose hotends are its tools (the H3C): which tool printed each filament, with the TPU tool flagged: on the H3C, tool 8 (hotend 7), where the printer reports its TPU hotend.'),
  /** sx engine: the prime tower as placed, when the plate prints one. */
  prime_tower: z.object({
    x: z.number().describe('Front left corner on the bed, mm'),
    y: z.number().describe('Front left corner on the bed, mm'),
    width: z.number().describe('mm'),
    depth: z.number().describe('mm'),
    angle: z.number().describe('Turn about the corner, degrees'),
  }).optional().describe('The prime tower as the engine placed it, when the plate prints one. A smooth timelapse (overrides timelapse_type "1") on a Bambu Lab printer prints one with a single filament too.'),
  plate: z.number().optional(),
  plate_count: z.number().optional().describe('How many plates of the project have something to print, when it has more than one and no plate was asked for'),
  plate_type: z.string().optional().describe('The plate type the call named in plate_type, as the app names it'),
  gcode_path: z.string().optional(),
  gcode_sha256: z.string().optional(),
  gcode_3mf_path: z.string().optional(),
  preview_path: z.string().optional(),
  applied: z.array(z.string()),
  /** How the project's own printer G-code was used (project_settings). */
  project_gcode: z.array(z.object({ key: z.string(), slot: z.number().optional(), use: z.enum(['project', 'profile']), message: z.string() })).optional(),
  warnings: z.array(z.string()),
  /**
   * With project_settings and a machine: profile: the printer another slicer's project was made for, the machine:
   * profile that slices it there (for a printer SlicerX has a profile for), and whether this slice used it. A project_printer
   * notice names that profile when the slice is for another printer.
   */
  project_printer: z.object({ name: z.string(), profile: z.string().optional(), nozzle: z.number().optional(), used: z.boolean().optional() }).optional(),
  /** `warnings` with the engine's code (as written), layer (0 based) and object id for each, when the engine gives them. */
  warning_details: z.array(z.object({ code: z.string(), message: z.string(), layer: z.number().optional(), object_id: z.string().optional() })).optional(),
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
      skipped: z.string().optional(),
    })
    .optional(),
  /** Which wall generator the slice ran and why. */
  walls: z.object({ generator: z.string(), source: z.enum(['kept', 'project', 'request', 'profile']), text: z.string() }).optional(),
  /** Warnings with a code an app can act on, each also in `warnings`: `ignored_arguments` when the call carried arguments the tool does not take (named in the message), `no_printer` when no printer was named, `other_plates` when a project of more than one plate was sliced without a plate, `project_printer` when another slicer's project was sliced for a printer other than the one it was made for (the message names the machine: profile that uses it). */
  notices: z.array(z.object({ code: z.enum(['ignored_arguments', 'no_printer', 'other_plates', 'project_printer']), message: z.string() })).optional(),
  note: z.string().optional(),
}

export { ignoredArgumentsMessage }

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
export type SliceArgs = { script_replacements?: ScriptReplacementChoice[]; script_printer?: { model: string; firmware: string }; model: string; plate?: number | undefined; plate_type?: string | undefined; placement?: 'center' | 'keep' | 'arrange'; spacing_mm?: number | undefined; rotate?: boolean | undefined; step_deg?: number | undefined; effort?: 'quick' | 'normal' | 'thorough' | undefined; keep?: string[] | undefined; new_plates?: boolean | undefined; project_settings: boolean; strict_settings?: boolean; project_gcode: 'review' | 'profile'; allow_collisions?: boolean; paint?: Record<string, Record<string, Record<string, string>>> | undefined; profiles: string[]; profile_files: string[]; filaments?: SlotArg[] | undefined; overrides?: Record<string, unknown> | undefined; output?: 'gcode' | 'gcode.3mf'; preview?: boolean; preview_format?: 'v1' | 'v2' }

const PLATE_NAMES = `Use one of: ${BED_TYPE_OPTIONS.map((o) => o.label).join(', ')}.`

/** The plate type plate_type names, refused when no plate type has that name. */
function plateType(name: string): BedType {
  const bed = bedTypeByName(name)
  if (!bed) throw new ToolInputError(`plate_type: no plate is called "${name.trim()}". ${PLATE_NAMES}`, 'invalid_input')
  return bed
}

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
export async function runSlice(d: ServerToolDeps, args: SliceArgs, emitGcode: boolean, report: (message: string, fraction: number) => void, known: readonly string[] = Object.keys(emitGcode ? sliceFileInput : sliceInput), arrangeOnly = false): Promise<ToolOutput> {
  const { store, profiles } = d
  const progress = async (p: number, message: string): Promise<void> => report(message, p)
  if (!d.slicer) throw new ToolInputError(d.slicerUnavailable ?? 'No slicing engine is available.', 'engine_unavailable')
  const slicer = d.slicer
  if ((arrangeOnly || args.placement === 'arrange') && (slicer.kind !== 'sx' || (arrangeOnly && !slicer.arrange))) throw new ToolInputError('Arranging a plate takes the sx engine. Install the sx CLI (docs/install.md).', 'engine_unavailable')
  const asked3mf = emitGcode && args.output === 'gcode.3mf'
  if (asked3mf && slicer.kind === 'stub') throw new ToolInputError('The stub engine writes no printable G-code, so it cannot make a .gcode.3mf. Install the sx CLI (docs/install.md).', 'engine_unavailable')
  // The plate type is the call's to set, as a person sets it on the plate in the app, never a setting override.
  const takesPlate = known.includes('plate_type')
  if (takesPlate && args.overrides?.['curr_bed_type'] !== undefined) throw new ToolInputError(`overrides: set the plate type with plate_type, not curr_bed_type. ${PLATE_NAMES}`, 'invalid_settings')
  const bed = takesPlate && args.plate_type !== undefined ? plateType(args.plate_type) : undefined
  const plateLabel = bed ? BED_TYPE_OPTIONS.find((o) => o.value === bed)?.label : undefined
  await progress(0, 'Reading the model')
  const modelPath = await resolveModel(d.policy, args.model)
  const isProject = ['.3mf', '.sx3mf'].includes(extname(modelPath).toLowerCase())
  if ((args.plate !== undefined || args.project_settings) && !isProject) throw new ToolInputError(`${basename(modelPath)} is not a 3MF or .sx3mf project, so it has no plates or project settings`, 'invalid_input')
  let project: ExtraLayers['project']
  let importReport: ReturnType<typeof readProjectFile>['summary']['import_report'] | undefined
  let projectRead: ReturnType<typeof readProjectFile> | undefined
  // The printer the project was made for, and whether this slice is for it (the app's open note says the same).
  let madeFor: ReturnType<typeof projectPrinterUse>
  if (isProject && (args.project_settings || args.plate !== undefined)) {
    const read = readProjectFile(modelPath)
    projectRead = read
    if (args.project_settings) {
      importReport = read.summary.import_report
      const r = importReport
      if (args.strict_settings && (r.unknown.length || r.invalid.length || r.skipped)) {
        throw new ToolInputError(`${basename(modelPath)}'s print settings carry what ${productName()} cannot use (strict_settings): ${importReportLines(r).join('; ')}`, 'project_settings_unused')
      }
    }
    if (args.plate !== undefined && !read.summary.plates.some((p) => p.index === args.plate)) {
      throw new ToolInputError(`${basename(modelPath)} has no plate ${args.plate}. Plates: ${read.summary.plates.map((p) => p.index).join(', ')}.`, 'no_such_plate')
    }
    // A project keeps a print sequence and a plate type per plate, over the project's.
    const own = read.summary.plates.find((p) => p.index === args.plate) ?? read.summary.plates[0]
    const seq = own?.print_sequence
    const printer = read.summary.presets.printer ? printerForProfile(read.summary.presets.printer)?.printerId : undefined
    if (args.project_settings) project = { name: basename(modelPath), config: { ...read.config, ...(seq ? { print_sequence: seq } : {}) }, unmodeled: read.unmodeled, model: printer, gcode: args.project_gcode, ...(own?.bed_type ? { bedType: own.bed_type } : {}) }
  }
  await progress(0.1, 'Resolving settings')
  // The project's own printer too: a slice of a project that names no machine: profile ends on it.
  await profiles.prepare([...args.profiles, ...(args.filaments ?? []).flatMap((s) => (s.profile ? [s.profile] : []))], [project?.model])
  // Another slicer's project on a printer slices with the settings the app opens it with (project-open.ts).
  if (project && projectRead) {
    const asked = args.overrides?.['nozzle_diameter']
    const mm = Number(Array.isArray(asked) ? asked[0] : asked)
    const opened = await openProject(projectRead, profiles, args.profiles, asked !== undefined && Number.isFinite(mm) && mm > 0 ? mm : undefined, args.plate)
    if (opened) project = { ...project, opened, model: opened.printer }
    madeFor = projectPrinterUse(projectRead, opened, basename(modelPath))
  }
  const presets = args.profile_files.length ? await readPresetFiles(d.policy, args.profile_files) : undefined
  // A printer preset file can move the slice to another printer, and the opened project slices on the one it opened on.
  await profiles.prepare([], [project?.opened?.printer, slicePrinter(profiles, args.profiles, presets ?? [], project)?.printerId])
  const slots = args.filaments?.length ? await slotLayers(d, args.filaments) : undefined
  if (args.script_replacements) {
    if (!project || !args.script_printer || args.project_gcode !== 'review' || slicer.kind !== 'sx') throw new ToolInputError('Explicit stock replacement requires project settings, project_gcode review, script_printer and the sx engine', 'invalid_input')
    project = { ...project, config: replacementConfig(project.config, args.script_replacements, 'candidate') }
  }
  const scriptReviews = await reviewProjectScripts(profiles, args.profiles, { project, presets, slots }, args.overrides, slicer, args.script_printer)
  const { config, explicit, applied, trustedGcode, gcodeKept, gcodeReplaced, noPrinter, widthsAsGiven } = resolveSliceConfig(store, profiles, args.profiles, args.overrides, { project, presets, slots, scriptReviews, ...(bed ? { bedType: bed } : {}) })
  const projectGcode = [
    ...gcodeKept.filter((k) => !args.script_replacements?.some((c) => c.key === k.key && c.slot === k.slot)).map((k) => ({ key: k.key, ...(k.slot !== undefined ? { slot: k.slot } : {}), use: 'project' as const, message: `The project's ${k.label} ${k.message}.` })),
    ...gcodeReplaced.map((k) => ({ key: k, use: 'profile' as const, message: `Used the printer profile's ${gcodeLabel(k)} instead of the project's.` })),
  ]
  // An object's own layer height in the file beats smart layer heights a profile turns on, as the app opens another
  // slicer's project with fixed layers. Smart layers the client asks for stay, and the engine's warning names the
  // layer heights they replace.
  let layerNote: string | undefined
  const smart = explicit['smart_layer']
  if (isProject && args.overrides?.['smart_layer'] === undefined && smart !== undefined && smart !== 'off' && smart !== false) {
    const own = objectLayerHeights(projectRead ?? modelPath, args.plate)
    if (own.length) {
      explicit['smart_layer'] = config['smart_layer'] = 'off'
      layerNote = `Smart layer heights are off for this slice: objects in ${basename(modelPath)} set their own layer height (${own.map((o) => `${o.name} ${o.layer_height} mm`).join(', ')}).`
    }
  }
  // A .gcode.3mf carries the plate picture: ask the engine to draw one when the settings name no thumbnail sizes.
  if (asked3mf && explicit['thumbnails'] === undefined) explicit['thumbnails'] = config['thumbnails'] = PLATE_THUMBNAILS
  // The printer's chamber limit from the catalog (the H3C heats to 65 C): the engine holds the slice to it and warns.
  const sliced = slicePrinter(profiles, args.profiles, presets ?? [], project)
  const chamberMaxC = sliced ? printerProfile(sliced.printerId)?.limits.chamberMaxTemp : undefined
  await progress(0.2, arrangeOnly ? 'Arranging' : 'Slicing')
  const outDir = join(d.policy.outDir, 'jobs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
  const arrangeSpec = { ...(args.spacing_mm !== undefined ? { spacingMm: args.spacing_mm } : {}), ...(args.rotate === false ? { rotate: false } : {}), ...(args.step_deg !== undefined ? { stepDeg: args.step_deg } : {}), ...(args.effort ? { effort: args.effort } : {}), ...(args.keep?.length ? { keep: args.keep } : {}), ...(args.new_plates ? { newPlates: true } : {}) }
  const job: SliceJob = {
    modelPath,
    ...(args.plate !== undefined ? { modelPlate: args.plate } : {}),
    ...(args.placement === 'keep' || args.placement === 'arrange' ? { placement: args.placement } : {}),
    ...(arrangeOnly || args.placement === 'arrange' ? { arrange: arrangeSpec } : {}),
    config,
    explicitConfig: args.script_replacements ? replacementConfig(explicit, args.script_replacements, 'original') : explicit,
    ...(args.script_replacements ? { scriptReplacements: args.script_replacements, scriptPrinter: args.script_printer } : {}),
    profileNames: args.profiles,
    overrides: Object.fromEntries(Object.entries(args.overrides ?? {}).map(([k, v]) => [k, toSchemaValue(store.setting(k), v)])),
    outDir,
    emitGcode,
    trustedGcode,
    ...(chamberMaxC !== undefined ? { machineLimits: { chamberMaxC } } : {}),
    ...(widthsAsGiven.length ? { widthsAsGiven } : {}),
    emitPreview: emitGcode && args.preview === true && slicer.kind === 'sx',
    ...(args.preview_format === 'v2' ? { previewFormat: 'v2' as const } : {}),
    ...(args.allow_collisions ? { allowCollisions: true } : {}),
    ...(args.paint ? { paint: args.paint } : {}),
  }
  if (arrangeOnly) return arrangeOutput(await slicer.arrange!(job), modelPath, args, known, applied, noPrinter ? noPrinterMessage(config) : undefined)
  const result: SliceSummary = await slicer.slice(job)
  if (asked3mf && result.gcode_path) {
    await progress(0.9, 'Writing the .gcode.3mf')
    const path = join(outDir, `${basename(modelPath, extname(modelPath))}${args.plate ? `-plate${args.plate}` : ''}.gcode.3mf`)
    // A Vault design's print file names its listing and carries no mesh, as the app writes it.
    writeFileSync(path, gcode3mf(readFileSync(result.gcode_path, 'utf8'), result, config, vaultMark(modelPath)))
    result.gcode_3mf_path = path
  }
  await progress(1, 'Done')
  // The engine knows only that the settings set the chamber mode; the layers say whether an override, the project or a
  // preset did. Overrides apply last, so one wins.
  if (result.chamber_cooling?.source === 'config') {
    const own = project?.config[CHAMBER_KEY]
    result.chamber_cooling.source = args.overrides?.[CHAMBER_KEY] !== undefined ? 'override' : own !== undefined && String(own) === String(config[CHAMBER_KEY]) ? 'project' : 'preset'
  }
  const walls: WallsNote = sliceWalls(config['wall_generator'], args.overrides, importReport?.walls)
  const ignored = ignoredArgumentsMessage(args, known)
  const notices: { code: 'ignored_arguments' | 'no_printer' | 'other_plates' | 'project_printer'; message: string }[] = [
    ...(ignored ? [{ code: 'ignored_arguments' as const, message: ignored }] : []),
    ...(noPrinter ? [{ code: 'no_printer' as const, message: noPrinterMessage(config) }] : []),
    ...(madeFor?.message ? [{ code: 'project_printer' as const, message: madeFor.message }] : []),
  ]
  if (result.plate_count && args.plate === undefined) notices.push({ code: 'other_plates', message: `${basename(modelPath)} has ${result.plate_count} plates; sliced plate ${result.plate}. Pass plate to slice another.` })
  for (const n of notices) result.warnings.push(n.message)
  if (layerNote) result.warnings.push(layerNote)
  const lines = [
    `${result.model.name}${result.plate ? `, plate ${result.plate}` : ''}: ${result.layer_count} layers, ${result.time_text}, ${result.filament_g} g (${(result.filament_mm / 1000).toFixed(2)} m) [engine ${result.engine}]`,
    ...(result.filaments.length > 1 ? [`Filaments: ${result.filaments.map((f) => `slot ${f.slot} ${f.filament_g} g`).join(', ')}`] : []),
    ...(applied.length ? [`Profiles: ${applied.join(', ')}`] : []),
    ...(plateLabel ? [`Plate type: ${plateLabel}`] : []),
    ...(result.gcode_path ? [`G-code: ${result.gcode_path}`] : []),
    ...(result.gcode_3mf_path ? [`G-code 3MF: ${result.gcode_3mf_path}`] : []),
    ...(result.preview_path ? [`Preview: ${result.preview_path}`] : []),
    `Walls: ${walls.text}`,
    ...(result.chamber_cooling ? [`Chamber: ${result.chamber_cooling.text} (${result.chamber_cooling.source})`] : []),
    ...(result.prime_tower ? [`Prime tower: ${result.prime_tower.width} x ${result.prime_tower.depth} mm at (${result.prime_tower.x}, ${result.prime_tower.y})`] : []),
    ...result.warnings.map((w) => `Warning: ${w}`),
    ...(importReport ? importReportLines(importReport, false).map((l) => `Project settings: ${l}`) : []),
    ...(result.note ? [result.note] : []),
  ]
  return { summary: lines[0] ?? 'Sliced', structured: { ...result, applied, ...(plateLabel ? { plate_type: plateLabel } : {}), ...(scriptReviews.length ? { script_reviews: scriptReviews.map(({ key, slot, review }) => ({ key, ...(slot === undefined ? {} : { slot }), ...review })) } : {}), ...(projectGcode.length ? { project_gcode: projectGcode } : {}), ...(notices.length ? { notices } : {}), ...(importReport ? { import_report: importReport } : {}), ...(madeFor ? { project_printer: madeFor.report } : {}), walls }, text: [...lines, ...projectGcode.map((g) => g.message)].join('\n') }
}


/** slicerx_arrange_file's answer: the layout, a line per part, and the parts with no room named. */
function arrangeOutput(a: Arranged, modelPath: string, args: SliceArgs, known: readonly string[], applied: string[], noPrinter: string | undefined): ToolOutput {
  const ignored = ignoredArgumentsMessage(args, known)
  const warnings = [...(ignored ? [ignored] : []), ...(noPrinter ? [noPrinter] : [])]
  const how = a.by_object ? `by object, ${a.clearance_mm ?? 0} mm extruder clearance apart${a.lanes ? ', tall parts in lanes' : ''}` : `by layer, ${a.spacing_mm} mm apart`
  const head = a.fits
    ? `Arranged ${a.objects.length} part${a.objects.length === 1 ? '' : 's'} of ${basename(modelPath)}${args.plate ? `, plate ${args.plate}` : ''} (${how})`
    : `No room on the bed for ${a.not_fit.map((o) => o.name).join(', ')}; ${a.objects.length} of ${a.objects.length + a.not_fit.length} parts fit (${how})`
  const lines = [
    head,
    ...a.objects.map((o) => `${o.name}: center (${o.center_mm[0]}, ${o.center_mm[1]}) mm${o.turn_deg ? `, turned ${o.turn_deg} degrees` : ''}`),
    ...(a.keep_out.length ? [`Kept clear of: ${a.keep_out.join(', ')}`] : []),
    ...(a.fits ? ['Slice it with slicerx_slice_file and placement "arrange" for this layout.'] : ['Take some parts off the plate, scale them down, or slice them on another plate.']),
    ...warnings.map((w) => `Warning: ${w}`),
  ]
  return { summary: head, structured: { engine: 'sx', model: { name: basename(modelPath) }, ...(args.plate !== undefined ? { plate: args.plate } : {}), ...a, applied, warnings }, text: lines.join('\n') }
}
