// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools and what they read back, on any design host (cad-history host.ts): the MCP server's designs
// (design.ts) or the app's plate. No Node imports, so the app runs the same definitions; files come through
// DesignFiles, which only the server has.
import { bakeMesh, keyOfTriangle, mainNumber, replayHistory, stepName, timelineOf, timelineSummary, withNumber, type Design as HostDesign, type DesignHost, type History, type HistoryMesh, type Mat4, type Step } from '@slicerx/cad-history'
import { defineTool, type PilotTool, type ToolOutput } from '@slicerx/pilot'
import { z } from 'zod'
import { productName } from '@slicerx/contracts'
import { bodyFacts } from './body-facts'
import { assumptionsInput, createPlanRegistry, designCheck, FIX_ROUNDS, fixRoundOpen, hasHookLip, isNamingMiss, nozzleOr, openFacesProblem, partPlanSchema, plannedFloor, plannedHoleMm, PlanOwnedError, printsTogether, stalePlanNote, supersededPlanNote, type PartPlan, type PlanEntry, type PlanRegistry } from './design-check'
import type { TextureOpen, TextureSummary } from './design'
import { ToolInputError } from './errors'
import { MAX_FILAMENTS } from './filaments'
import { designStamp, runFitLimits, type FitProfile } from './fit-facts'
import { AMEND_REASON_MAX, amendChanges, amendedSizes, amendProblem, amendReason, amendShapeProblem, changeText } from './plan-amend'
import { jointProblem, LID_STATEMENT, planFloors, underFloors, underLine, type PlanFloors, type UnderFloor } from './plan-floors'
import { meshStats } from './mesh'

type V3 = [number, number, number]

/** A design on this server: the host's design (cad-history host.ts), plus the STL files it writes. */
export interface Design extends HostDesign {
  /** The STL of the parts after the last change, in the output folder. */
  stl?: string
  /** How many STL files this design has written, for their names. */
  written?: number
}

export const designArg = z.string().min(1).describe('A design id from slicerx_design_new or slicerx_design_open')
/** The planned feature a modeling step builds, recorded on the step so design.check ties the step to the plan. */
export const featureArg = z.string().max(60).optional().describe('The plan feature this step builds, by its name in the plan')
/** `opts` with the planned feature a modeling tool was given, for the host's add; a blank one is none. */
export const withFeature = <T extends object>(feature: string | undefined, opts?: T): (T & { feature?: string }) | undefined => (feature?.trim() ? { ...(opts ?? ({} as T)), feature: feature.trim() } : opts)

/** The plans a modeling tool reads to name a new part after the print-in-place piece it builds. */
export type PiecePlans = Pick<PlanRegistry, 'tiedTo' | 'get'>

/**
 * The name a new part of design `d` takes when it builds a print-in-place piece: a plan tied to the design whose
 * printInPlace names a piece exactly as `feature` (the plan feature the step builds) gives the part that piece's name,
 * so design.check finds the piece under the plan's name. Undefined keeps the name given: no feature, no tied plan
 * naming it (or tied plans naming it two ways), a name given that is already one of that plan's pieces, or another
 * part of the design that has the piece's name already.
 */
export function pieceNameFor(plans: PiecePlans | undefined, d: HostDesign, feature: string | undefined, given: string | undefined): string | undefined {
  const key = (s: string): string => s.trim().toLowerCase()
  const f = feature?.trim()
  if (!plans || !f) return undefined
  const found = new Map<string, string>()
  for (const id of plans.tiedTo(d.id)) {
    const e = plans.get(id)
    const pieces = e && !e.stale && !e.superseded ? e.plan.printInPlace : undefined
    if (!Array.isArray(pieces)) continue
    if (given !== undefined && pieces.some((p) => key(p) === key(given))) return undefined
    for (const p of pieces) if (key(p) === key(f)) found.set(key(p), p.trim())
  }
  if (found.size !== 1) return undefined
  const piece = [...found.values()][0]!
  if (d.parts.some((p) => key(p.name) === key(piece))) return undefined
  return piece
}

/** What a tool's summary adds when it named a new part after its plan's piece. */
export const pieceNameNote = (piece: string, given: string | undefined): string => `. The new part is named ${piece}, as the plan names that print-in-place piece${given !== undefined ? `, in place of ${given}` : ''}`

/** The files the design tools read and write. The app has none: its designs open and save with the project. */
export interface DesignFiles {
  /** The parts of a model (an STL path, URL or sample: name) to start a design from. */
  model(from: string, name: string): Promise<HistoryMesh[]>
  /**
   * The objects of a 3MF to open as designs, with their history when they have one, painted from its textures when
   * asked, and the reader's notes on what it skipped or read another way.
   */
  open(path: string, texture?: TextureOpen): Promise<{ designs: { name: string; transform: Mat4; history?: History; base: HistoryMesh[]; skipped: string[]; texture?: TextureSummary }[]; notes: string[] }>
  /** Writes the design as a 3MF project; `fileName` without folders, the design's name when absent. */
  save(d: Design, fileName: string | undefined): Promise<{ path: string; bytes: number }>
}

/** The part and triangle under a point on a face (world), facing `normal` when given. */
export function faceAt(d: HostDesign, at: V3, normal?: V3, parts: readonly HistoryMesh[] = d.parts): { part: number; triangle: number; normal: V3; key: number | undefined } {
  let best: { part: number; triangle: number; normal: V3; score: number } | null = null
  parts.forEach((p, part) => {
    const w = bakeMesh(p, d.transform)
    for (let t = 0; t + 2 < w.indices.length; t += 3) {
      const tri = corners(w, t)
      const n = triNormal(tri)
      if (!n) continue
      if (distance(at, tri) > NEAR_MM) continue
      const score = normal ? dot(n, unit(normal) ?? n) : 1
      if (!best || score > best.score) best = { part, triangle: t / 3, normal: n, score }
    }
  })
  const hit = best as { part: number; triangle: number; normal: V3; score: number } | null
  if (!hit) throw new ToolInputError(`at: no face of the design within ${NEAR_MM} mm of (${at.join(', ')}); slicerx_geom_faces with the design lists a point on every flat face`)
  // The normal only says which face at a shared point is meant; a curved wall's facets lean a few degrees off it.
  if (normal && hit.score < Math.cos((30 * Math.PI) / 180)) throw new ToolInputError('normal: no face at that point faces that way; give the outward normal of the face you mean')
  const key = keyOfTriangle(parts[hit.part]!, hit.triangle)
  return { part: hit.part, triangle: hit.triangle, normal: hit.normal, key: key || undefined }
}

/** The parts as they were right after `step` (an index from 1, an id or a step's name); the latest parts without one. */
export async function partsAt(host: DesignHost, d: HostDesign, step?: number | string): Promise<HistoryMesh[]> {
  if (step === undefined) return d.parts
  const k = stepIndex(d, step)
  if (k === d.history.steps.length - 1) return d.parts
  const r = await replayHistory((op, request) => host.call(op, request), { history: { ...d.history, steps: d.history.steps.slice(0, k + 1) } })
  if (d.history.exact) {
    const broken = r.status.find(s => s.state === 'broken' || s.state === 'skipped')
    if (broken || r.exactFellBack?.length) throw new ToolInputError(`Exact history could not be inspected: ${broken?.message ?? 'a step requires the mesh path'}.`)
  }
  return r.parts
}

/** The part whose surface holds a point (world), or the first part when none is near. */
export function partAt(d: HostDesign, at: V3): number {
  for (const [i, p] of d.parts.entries()) {
    const w = bakeMesh(p, d.transform)
    for (let t = 0; t + 2 < w.indices.length; t += 3) if (distance(at, corners(w, t)) <= NEAR_MM) return i
  }
  return 0
}

/** A part as an engine mesh item, with the object's transform. */
export function item(d: HostDesign, part: number, parts: readonly HistoryMesh[] = d.parts): { mesh: { positions: number[]; indices: number[]; faces?: unknown }; transform: Mat4 } {
  const p = parts[part]
  if (!p) throw new ToolInputError(`part: the design has ${parts.length} part${parts.length === 1 ? '' : 's'}`)
  return { mesh: { positions: Array.from(p.positions), indices: Array.from(p.indices), ...(p.faces ? { faces: { ...p.faces, ids: Array.from(p.faces.ids) } } : {}) }, transform: d.transform }
}

/** STL coordinates are float32, so a point typed from a reply can be off by a few micrometers. */
const NEAR_MM = 0.02

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: V3): V3 | undefined => {
  const l = Math.hypot(a[0], a[1], a[2])
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : undefined
}

function corners(m: Pick<HistoryMesh, 'positions' | 'indices'>, t: number): [V3, V3, V3] {
  const at = (k: number): V3 => {
    const i = (m.indices[t + k] ?? 0) * 3
    return [m.positions[i] ?? 0, m.positions[i + 1] ?? 0, m.positions[i + 2] ?? 0]
  }
  return [at(0), at(1), at(2)]
}

const triNormal = ([a, b, c]: [V3, V3, V3]): V3 | undefined => unit(cross(sub(b, a), sub(c, a)))

/** Distance from a point to a triangle (closest point on the triangle, Ericson 5.1.5). */
function distance(q: V3, [a, b, c]: [V3, V3, V3]): number {
  const ab = sub(b, a)
  const ac = sub(c, a)
  const ap = sub(q, a)
  const d1 = dot(ab, ap)
  const d2 = dot(ac, ap)
  const len = (v: V3): number => Math.hypot(v[0], v[1], v[2])
  const at = (o: V3, d: V3, s: number): V3 => [o[0] + d[0] * s, o[1] + d[1] * s, o[2] + d[2] * s]
  if (d1 <= 0 && d2 <= 0) return len(ap)
  const bp = sub(q, b)
  const d3 = dot(ab, bp)
  const d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return len(bp)
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return len(sub(q, at(a, ab, d1 / (d1 - d3))))
  const cp = sub(q, c)
  const d5 = dot(ab, cp)
  const d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return len(cp)
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return len(sub(q, at(a, ac, d2 / (d2 - d6))))
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return len(sub(q, at(b, sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))))
  const den = 1 / (va + vb + vc)
  return len(sub(q, [a[0] + ab[0] * vb * den + ac[0] * vc * den, a[1] + ab[1] * vb * den + ac[1] * vc * den, a[2] + ab[2] * vb * den + ac[2] * vc * den]))
}

/** Indexed parts as one triangle soup. */
export function soup(parts: readonly Pick<HistoryMesh, 'positions' | 'indices'>[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.indices.length, 0)
  const out = new Float32Array(n * 3)
  let o = 0
  for (const p of parts)
    for (let k = 0; k < p.indices.length; k++) {
      const i = (p.indices[k] ?? 0) * 3
      out[o++] = p.positions[i] ?? 0
      out[o++] = p.positions[i + 1] ?? 0
      out[o++] = p.positions[i + 2] ?? 0
    }
  return out
}

export const slug = (s: string): string => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design'
const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** The reader's notes as the app's open note says them: a whole sentence as it is, the rest after "Not everything in the file was read:". */
function notesLine(notes: readonly string[]): string {
  const whole = notes.filter((n) => /^[A-Z].*[.!?]$/s.test(n))
  const rest = notes.filter((n) => !whole.includes(n)).map((n) => n.replace(/[.;\s]+$/, ''))
  return [...(rest.length ? [`Not everything in the file was read: ${rest.join('; ')}.`] : []), ...whole].join(' ')
}

/** What a client reads back after every change: the parts with their sizes and volumes, and the last step. */
export function designSummary(d: Design): Record<string, unknown> {
  const parts = d.parts.map((p, i) => {
    const s = meshStats(soup([bakeMesh(p, d.transform)]))
    const paint = p.paint
    const painted = paint ? Object.fromEntries(Object.entries(paint).map(([k, v]) => [k, Object.keys(v ?? {}).length])) : undefined
    return { index: i, name: p.name, slot: p.slot, triangles: s.triangles, minMm: s.minMm, sizeMm: s.bboxMm, volumeMm3: r3(s.volumeMm3), ...(painted ? { paintedTriangles: painted } : {}) }
  })
  const all = d.parts.length ? meshStats(soup(d.parts.map((p) => bakeMesh(p, d.transform)))) : null
  const last = d.history.steps.length ? stepRow(d, d.history.steps.length - 1) : null
  return {
    design: d.id,
    name: d.name,
    exact: d.history.exact === true,
    steps: d.history.steps.length,
    ...(last ? { lastStep: last } : {}),
    ...(all ? { minMm: all.minMm, sizeMm: all.bboxMm } : {}),
    volumeMm3: r3(parts.reduce((s, p) => s + p.volumeMm3, 0)),
    parts,
    ...(d.stl ? { stlPath: d.stl } : {}),
    ...(d.history.ended ? { ended: d.history.ended } : {}),
    ...(d.placed ? { placedMm: d.placed } : {}),
    ...(d.landed ? { landed: landedNote(d.landed, d.name) } : {}),
  }
}

/** What a client hears when the first body landed on the bed, or an edit moved the part, or either could not. */
export function landedNote(l: NonNullable<Design['landed']>, name = 'The part'): string {
  if (l.edit) {
    if (!('offBed' in l)) return `${name} did not fit on the bed where it stood, so it moved by (${l.dxMm}, ${l.dyMm}) mm as a whole; its coordinates stay the design's own.`
    if (l.parked) return `${name} is off the bed, so it stays where it is. Move it onto the bed to print it.`
    if (l.locked) return `${name} does not fit on the bed where it stands, and it is locked, so it stays. Unlock it or undo the step.`
    return `${name} does not fit on the bed. Make it smaller or undo the step.`
  }
  if ('offBed' in l) return 'The part does not fit on the bed anywhere, so it stays where it was built, off the bed.'
  const room = l.room?.length ? ` ${l.room.map((r) => `${r.name} moved by (${r.dxMm}, ${r.dyMm}) mm`).join(', ')} to make room; each keeps its own coordinates.` : ''
  return `The part was off the bed, so it moved to the plate by (${l.dxMm}, ${l.dyMm}) mm as a whole. Its coordinates stay the design's own: keep giving points in the frame it was built in.${room}`
}

function stepRow(d: Design, i: number): Record<string, unknown> {
  const s = d.history.steps[i]!
  const st = d.status[i]
  const n = mainNumber(s.params)
  return {
    index: i + 1,
    id: s.id,
    name: stepName(s),
    op: s.params.op,
    part: s.part,
    ...(n ? { value: { label: n.label, value: n.value, unit: n.unit } } : {}),
    ...(s.feature ? { feature: s.feature } : {}),
    state: s.suppressed ? 'suppressed' : (st?.state ?? 'done'),
    ...(st?.message ? { message: st.message } : {}),
    ...(st?.note ? { note: st.note } : {}),
  }
}

/** The step a client names: its 1-based index, its id, or its name ("Fillet 1.5 mm", the last one by that name). */
export function stepIndex(d: HostDesign, step: number | string): number {
  const named = (s: Step): boolean => typeof step === 'string' && stepName(s).toLowerCase() === step.trim().toLowerCase()
  const byName = d.history.steps.map((s, i) => (named(s) ? i : -1)).filter((i) => i >= 0).pop() ?? -1
  const i = typeof step === 'number' ? step - 1 : d.history.steps.some((s) => s.id === step) ? d.history.steps.findIndex((s) => s.id === step) : byName
  if (i < 0 || i >= d.history.steps.length) throw new ToolInputError(`step: the design has ${d.history.steps.length} step${d.history.steps.length === 1 ? '' : 's'}; give an index from 1 or a step id from slicerx_design_steps`)
  return i
}

/** The largest main number a step takes when edited, as its tool takes it (the rest stop at 10000). */
const EDIT_MAX: Partial<Record<string, number>> = { 'edge.fillet': 1000, 'edge.chamfer': 1000, hollow: 50, shell: 50 }

export async function replayChange(host: DesignHost, design: Design, history: History, redo = design.redo): Promise<void> {
  const candidate = { ...design, history, redo: [...redo] }
  await host.replay(candidate)
  if (!candidate.stl) delete design.stl
  Object.assign(design, candidate)
}

/** What design.check reads besides the design: the plans, and the nozzle the part prints with. */
export interface DesignToolOptions {
  /** The plans design.check finds by planId; default a registry of this toolset's own. */
  plans?: PlanRegistry | undefined
  /** The nozzle diameter in mm, for the thinnest wall; 0.4 when absent or not a positive finite number. */
  nozzleMm?: (() => number | undefined) | undefined
  /** The layer height and material the part prints with, for the gaps of a print-in-place plan; half the nozzle and PLA when absent. */
  fitProfile?: (() => FitProfile) | undefined
  /**
   * True on the side that owns the card plans (the mimir tab): design.check given a design ties an untied card plan
   * to it. Elsewhere (an MCP client over the app link) a design given for a card plan is checked but never tied.
   */
  cardSide?: boolean | undefined
}

/** Two names for one part: the same words, whatever the case or the spaces around them. */
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The design tools on a host; `files` reads the models design.new starts from and the 3MF files design.open and design.save use. */
export function designTools(designs: DesignHost, files: DesignFiles, opts: DesignToolOptions = {}): PilotTool<never>[] {
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
  const plans = opts.plans ?? createPlanRegistry()

  const create = defineTool({
    name: 'design.new',
    version: '1.2.0',
    source: 'command',
    permission: 'slice',
    description:
      `Start a design: a part you build step by step with the modeling tools (slicerx_geom_extrude, slicerx_geom_revolve, slicerx_geom_loft, slicerx_geom_sweep, slicerx_geom_push_pull, slicerx_geom_fillet, slicerx_geom_chamfer, slicerx_geom_hole, slicerx_geom_build, slicerx_geom_subtract, slicerx_geom_hollow, slicerx_geom_emboss, slicerx_geom_repair), each given this design id. Every step lands in the design's editable history, the same one ${productName()} keeps for a person, so slicerx_design_save writes a 3MF that opens with every step editable. Start empty (the first step makes a body) or from an STL. Units are mm, Z up, the bed at Z = 0. A name of an open design whose part already passed slicerx_design_check against its plan is refused, naming that design: change that design rather than building the part again, or give a second part another name.`,
    localDescription:
      'Start a design (name): a part the geom tools build step by step from its design id, each step editable in its history. Start empty (the first step makes a body) or from an STL (from). Units mm, Z up, bed at Z = 0. More: kb.search "modeling tools".',
    input: z.object({
      name: z.string().min(1).max(120).default('Design'),
      exact: z.boolean().optional().describe('Require native exact features, with developer opt-in. Unsupported operations refuse instead of using mesh geometry.'),
      from: z.string().min(1).optional().describe('Start from this model: an STL path, URL or sample: name. Absent: an empty design'),
    }),
    async run(i) {
      // a part that was built and passed its check against its plan is changed in its design, not built again
      const done = designs.list().find((d) => sameName(d.name, i.name) && plans.tiedTo(d.id).some((id) => plans.get(id)?.passed))
      if (done)
        throw new ToolInputError(
          `${done.name} is already built and passed its check against its plan, in the open design ${done.name}${opts.cardSide ? '' : ` (${done.id})`}. Change that design rather than building the part again; if the person asked for a second one, give it another name.`,
        )
      const base = i.from ? await files.model(i.from, i.name) : []
      const d = await designs.create(i.name, base, undefined, undefined, { exact: i.exact === true })
      return { summary: `Started ${d.name} (${d.id})${base.length ? ' from the model' : ''}${d.landed ? `. ${landedNote(d.landed, d.name)}` : ''}`, output: designSummary(d) }
    },
  })

  const open = defineTool({
    name: 'design.open',
    version: '1.3.0',
    source: 'command',
    permission: 'read',
    description:
      `Open the objects of any 3MF project (${productName()}, Bambu Studio, Orca) as designs, one per object. An object with a ${productName()} CAD history opens with its steps replayed; any other starts from its printed parts, with their filament slots and paint, and no steps yet. Modifiers and other volumes are left out and named. \`notes\` says what the file reader skipped or read another way, such as paint in a newer format, as the app's open note does.`,
    input: z.object({
      path: z.string().min(1).describe('Path of the .3mf file'),
      texture: z
        .object({
          filaments: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(MAX_FILAMENTS).describe('Filament colors as #rrggbb, slot 1 first'),
          mode: z.enum(['nearest', 'palette']).default('nearest').describe('nearest: each texture color to the nearest filament; palette: as many colors as filaments, picked from the texture'),
        })
        .optional()
        .describe("Paint the parts from the 3MF's textures (texture2d groups) as color paint: each bit of surface gets a filament, and the one with the most area becomes the part's own"),
    }),
    async run(i) {
      const { designs: found, notes } = await files.open(i.path, i.texture)
      if (!found.length) throw new ToolInputError(`${i.path} has no printed parts to open`)
      const opened = []
      for (const f of found) opened.push({ ...designSummary(await designs.create(f.name, f.history?.base ?? f.base, f.history, f.transform)), fromHistory: f.history !== undefined, ...(f.skipped.length ? { leftOut: f.skipped } : {}), ...(f.texture ? { texture: f.texture } : {}) })
      return { summary: `Opened ${plural(opened.length, 'design')}${notes.length ? `. ${notesLine(notes)}` : ''}`, output: { designs: opened, ...(notes.length ? { notes } : {}) } }
    },
  })

  const list = defineTool({
    name: 'design.list',
    version: '1.1.0',
    source: 'command',
    permission: 'read',
    description: 'The designs open on this server, with their parts, sizes and step counts.',
    input: z.object({}),
    async run() {
      const all = designs.list()
      return { summary: plural(all.length, 'design'), output: { designs: all.map(designSummary) } }
    },
  })

  const steps = defineTool({
    name: 'design.steps',
    version: '1.2.0',
    source: 'command',
    permission: 'read',
    description: 'The steps of a design in order: each one\'s index, id, name ("Pull 5 mm", "Fillet 0.5 mm"), the plan feature it builds when it was given one, its main number, and whether it went through, broke (with the reason) or is suppressed.',
    input: z.object({ design: designArg }),
    async run(i) {
      const d = designs.get(i.design)
      const rows = d.history.steps.map((_, k) => stepRow(d, k))
      const broken = rows.filter((r) => r['state'] === 'broken').length
      return { summary: `${plural(rows.length, 'step')}${broken ? `, ${broken} broken` : ''}`, output: { ...designSummary(d), steps: rows } }
    },
  })

  const edit = defineTool({
    name: 'design.edit_step',
    version: '1.3.0',
    source: 'command',
    permission: 'slice',
    description:
      `Edit one step of a design and replay the steps after it, as editing a step in ${productName()}'s history does: set its main number (the distance, depth, angle, radius, wall or diameter slicerx_design_steps shows as value), suppress it or turn it back on, rename it, or set the plan feature it builds. Setting a number clears that step's expression binding; renaming or suppressing it keeps the binding. Steps after it that no longer work are reported broken with the reason; edit them, or edit this one back.`,
    input: z.object({
      design: designArg,
      step: z.union([z.number().int().min(1), z.string().min(1)]).describe('Index from 1, or a step id'),
      value: z.number().min(-10_000).max(10_000).optional().describe('The new main number'),
      suppressed: z.boolean().optional(),
      label: z.string().max(120).optional().describe('A name for the step; empty for the one made from its numbers'),
      feature: z.string().max(60).optional().describe('The plan feature the step builds; empty for none'),
    }),
    async run(i) {
      const d = designs.get(i.design)
      const k = stepIndex(d, i.step)
      const s = d.history.steps[k]!
      let next: Step = s
      if (i.value !== undefined) {
        const most = EDIT_MAX[s.params.op]
        if (most !== undefined && Math.abs(i.value) > most) throw new ToolInputError(`value: at most ${most} for this step, as its tool takes`)
        const p = withNumber(s.params, i.value)
        if (typeof p === 'string') throw new ToolInputError(`value: ${p}`)
        const { bind: _bind, ...unbound } = next
        next = { ...unbound, params: p }
      }
      if (i.suppressed !== undefined) {
        const { suppressed: _s, ...rest } = next
        next = i.suppressed ? { ...rest, suppressed: true } : rest
      }
      if (i.label !== undefined) {
        const { label: _l, ...rest } = next
        next = i.label.trim() ? { ...rest, label: i.label.trim() } : rest
      }
      if (i.feature !== undefined) {
        const { feature: _f, ...rest } = next
        next = i.feature.trim() ? { ...rest, feature: i.feature.trim() } : rest
      }
      const { broken: _b, ...clean } = next
      await replayChange(designs, d, { ...d.history, steps: d.history.steps.map((x, j) => (j === k ? clean : x)) })
      const rows = d.history.steps.map((_, j) => stepRow(d, j))
      const broken = rows.filter((r) => r['state'] === 'broken')
      return { ok: broken.length === 0, summary: `Edited step ${k + 1}, ${stepName(clean)}${broken.length ? `; step ${String(broken[0]!['index'])} broke: ${String(broken[0]!['message'] ?? '')}` : ''}`, output: { ...designSummary(d), steps: rows } }
    },
  })

  const undo = defineTool({
    name: 'design.undo',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description: 'Remove the last step of a design and replay it, back to how it was before that step.',
    input: z.object({ design: designArg }),
    async run(i) {
      const d = designs.get(i.design)
      const last = d.history.steps[d.history.steps.length - 1]
      if (!last) throw new ToolInputError('The design has no steps to undo.')
      // Every host replays, even to no steps: the app's takes the body off the plate then.
      await replayChange(designs, d, { ...d.history, steps: d.history.steps.slice(0, -1) }, [...d.redo, last])
      return { summary: `Removed ${stepName(last)}`, output: designSummary(d) }
    },
  })

  const redo = defineTool({
    name: 'design.redo',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description: 'Put back the step slicerx_design_undo last removed. A new step clears what can be redone.',
    input: z.object({ design: designArg }),
    async run(i) {
      const d = designs.get(i.design)
      const step = d.redo.at(-1)
      if (!step) throw new ToolInputError('Nothing to redo.')
      await replayChange(designs, d, { ...d.history, steps: [...d.history.steps, step] }, d.redo.slice(0, -1))
      return { summary: `Put back ${stepName(step)}`, output: designSummary(d) }
    },
  })

  const timeline = defineTool({
    name: 'design.timeline',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `The design timeline: every sketch and feature across the designs in the order made, the way ${productName()}'s Model timeline shows them, with the marker (how many items are live; the end when nothing is rolled back). Each feature names its design (body) and, for an extrude or revolve of a sketch, the sketch's id.`,
    input: z.object({}),
    async run() {
      // in the app the project's own timeline answers (the app link); here it is the designs' steps by when made
      const t = timelineOf(designs.list().map((d) => ({ id: d.id, history: d.history })))
      const out = timelineSummary(t)
      return { summary: `${plural(out.items.length, 'item')}, at the end`, output: { ...out, rolledBack: false } }
    },
  })

  const roll = defineTool({
    name: 'design.roll',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: `Move the timeline marker, rolling the whole design back to how it was after that many items (0 is before everything; leave marker out for the end), as dragging the marker in ${productName()} does. Bodies made after the marker leave the plate, and slicing uses what shows. Works on the project open in ${productName()}, through the app link.`,
    input: z.object({ marker: z.number().int().min(0).max(100_000).optional().describe('How many timeline items stay live; leave out for the end') }),
    async run() {
      throw new ToolInputError(`Rolling the design back works on the project open in ${productName()}: turn on the app link there, then try again.`)
    },
  })

  const save = defineTool({
    name: 'design.save',
    version: '1.1.0',
    source: 'command',
    permission: 'slice',
    description: `Save a design as a 3MF project in the output folder: the parts with their filament slots, and the CAD history, so the file opens in ${productName()} with every step editable (other slicers open the parts). Also writes the parts as one STL.`,
    input: z.object({ design: designArg, file_name: z.string().min(1).max(120).optional().describe('File name without folders; default the design name') }),
    async run(i) {
      const d = designs.get(i.design)
      if (i.file_name && /[\\/]/.test(i.file_name)) throw new ToolInputError('file_name: a name only, without folders; the file goes to the output folder')
      const { path, bytes } = await files.save(d, i.file_name)
      return { summary: `Saved ${d.name}, ${plural(d.history.steps.length, 'step')}, to ${path}`, output: { path, bytes, ...designSummary(d) } }
    },
  })

  /**
   * Whether `next` can be a rebuild of the plan's part: the design it is tied to is still open, and `next` is open,
   * was not open when the plan's last check failed, and is tied to no plan. By the designs open then, not by their
   * order in the list, which deleting, undoing or redoing a design changes.
   */
  const rebuilt = (entry: PlanEntry, next: string): boolean => {
    const ids = designs.list().map((d) => d.id)
    if (!entry.design || !ids.includes(entry.design) || !ids.includes(next) || !entry.openAtFail) return false
    return !entry.openAtFail.includes(next) && plans.tiedTo(next).length === 0
  }

  /**
   * The design a plan was built in, and how it was chosen: the one it is tied to (or given now, which ties it), else
   * the one design named as the part, else the only design open. With several open and none tied or named, or two
   * named as the part, it refuses and asks which, rather than check the wrong part. A design given now ties a client
   * plan, or an untied card plan on the card's own side; a card plan is not tied again to another design, and a
   * client's given design for an untied card plan is checked without tying it. The one exception is a replacement: on
   * the card's own side, a card plan whose last check failed and still has its fix round follows the design given now,
   * since a part rebuilt as a new design to fix it is still the plan's part. Only a design started after that check
   * failed, while the tied design is still open, and tied to no other plan qualifies, once per failed check, so a mistaken or injected id never
   * moves a plan onto another part. Its failed checks carry over, so a replacement never buys a second fix round.
   */
  const builtFrom = (entry: PlanEntry, given: string | undefined): { design: HostDesign; how: 'tied to the plan' | 'given' | 'matched by name' | 'latest' } => {
    if (given) {
      // a card plan already tied keeps its design: any other one given, even one that names no open design, is refused,
      // except on the card's side a design started to fix the plan's failed check, which the plan moves to
      if (entry.origin === 'card' && entry.design) {
        let id: string | undefined
        try {
          id = designs.get(given).id
        } catch {
          id = undefined
        }
        const replaces = opts.cardSide && id !== undefined && id !== entry.design && entry.replaceable && rebuilt(entry, id)
        if (replaces) {
          const design = designs.get(id!)
          plans.replace(entry.plan.planId, design.id)
          return { design, how: 'tied to the plan' }
        }
        if (id !== entry.design && opts.cardSide && !designs.list().some((d) => d.id === entry.design))
          throw new ToolInputError(`design: the plan for ${entry.plan.part} was made in the mimir tab for a design that is no longer open. It is not moved to another design; make a new plan for the part and check it against that.`)
        // the card's own side shows the refusal in the mimir card's step row, so it names no plan or design id there
        if (id !== entry.design)
          throw new ToolInputError(
            opts.cardSide
              ? `design: the plan for ${entry.plan.part} was made in the mimir tab and is already tied to its own design. It is not tied again; check it without design, or check another plan.`
              : `design: plan ${entry.plan.planId} (${entry.plan.part}) was made in the mimir tab and is already tied to design ${entry.design}. It is not tied again; check it without design, or check another plan.`,
          )
        return { design: designs.get(entry.design), how: 'tied to the plan' }
      }
      // a design given by its name is the design it names, so it is compared and tied by its id
      const design = designs.get(given)
      if (entry.origin === 'card' && !opts.cardSide) return { design, how: 'given' }
      plans.tie(entry.plan.planId, design.id)
      return { design, how: 'tied to the plan' }
    }
    if (entry.design) return { design: designs.get(entry.design), how: 'tied to the plan' }
    const all = designs.list()
    const named = all.filter((d) => d.name.trim().toLowerCase() === entry.plan.part.trim().toLowerCase())
    if (named.length === 1) return { design: named[0]!, how: 'matched by name' }
    // on the card's own side the refusal is the mimir card's step row, so it names the part and the designs, no ids
    const card = opts.cardSide === true
    const plan = card ? `the plan for ${entry.plan.part}` : `plan ${entry.plan.planId} (${entry.plan.part})`
    const listed = (ds: readonly HostDesign[]): string => ds.map((d) => (card ? d.name : `${d.name} (${d.id})`)).join(', ')
    if (named.length > 1) throw new ToolInputError(`design: ${plan} is not tied to a design and ${named.length} open designs are named ${entry.plan.part}. Which design is it? ${listed(named)}. Check again with design set to its id.`)
    if (all.length === 0) throw new ToolInputError(`No design to check: build ${entry.plan.part} first, then check it against ${card ? 'its plan' : `plan ${entry.plan.planId}`}.`)
    if (all.length > 1) throw new ToolInputError(`design: ${plan} is not tied to a design and no open design is named ${entry.plan.part}. Which design is it? Open: ${listed(all)}. Check again with design set to its id.`)
    return { design: all[0]!, how: 'latest' }
  }

  /**
   * Whether geom.fit_check ran on the design as it is now, over the planned pieces: each piece's own part when every
   * piece names one, else every part (pieces that are bodies of one part, or named another way).
   */
  const fitLooked = (d: HostDesign, pieces: readonly string[]): boolean => {
    const run = plans.fitCheckOf(d.id)
    if (!run || run.stamp !== designStamp(d)) return false
    if (run.parts === 'all') return true
    const named = d.parts.flatMap((p, k) => (pieces.some((n) => sameName(n, p.name)) ? [k] : []))
    const want = named.length === pieces.length ? named : d.parts.map((_, k) => k)
    return want.every((k) => (run.parts as readonly number[]).includes(k))
  }

  const check = defineTool({
    name: 'design.check',
    version: '1.15.0',
    source: 'command',
    permission: 'read',
    description:
      "Check a built part against its plan, after its last feature: the overall size (within 0.2 mm or 1 percent, whichever is larger, axis by axis with z as the print height; parts laid out side by side are held to the largest; a display or fine plan passes within 1 mm or 5 percent, with a warning past the tighter one and no plan change needed), each named hole's diameter (within 0.1 mm) and, when the plan lists its holes, no holes it lacks, a step or more tagged with each planned feature (by step names when no step is tagged), that the body is closed (watertight: corners at the same point count as one, as the slicer reads it, and an open body's item says what keeps it open), for a display or fine plan, that no curved body built by a loft is one outline stretched one way (sections that only grow or shrink in width while their top and bottom stay put), that its thinnest wall is at least twice the nozzle away from sharp edges and points (a thinner reading within two nozzle widths of a sharp outward edge or a point, the taper of a rim or a bow, passes with a warning that says where; a passed item can carry a warning, and the summary lists them) and, when the plan has a hook with a lip, that the hook's tip rises at least 3 mm above its lowest point toward its end and, when the plan sets a floor (a floor or bottom thickness in a plan with a wall, or a cut or shell down into the part at least half as deep as it is tall but less; a cut with its own height, such as window slits in a side, sets none), that the part is closed at the bottom: no opening through its lowest face but holes up to the plan's widest, each opening named by where it runs. A plan with printInPlace also gets pieces (each named piece a separate body) and gaps (between moving pieces, by nozzle, layer and material; gap sizes in the plan too), and is checked only after slicerx_geom_fit_check has run on the design as it is now, over the planned pieces; until then the check is refused and uses no check. A plan the person made in the mimir tab whose sizes they changed on a sheet after approving it is refused until a new plan is answered, and still refused after that answer, approved or declined. Inch plans are compared in mm. It checks the design tied to the plan, else the one named as the plan's part, else the only one open; with several open, or two named as the part, it asks which (give design). Returns which design it checked and how it chose it, pass, and every item with what the plan wants and what the body has; fix the failed items once and check again. A plan gets one fix round: when its second check fails too, the result adds stop, a plain instruction to stop building and tell the person exactly what is off, and every later check of that plan returns that same result (with repeated) without measuring the part again. A new plan, with a new planId, starts over. A plan changed with amends is checked at its new sizes, and the result gives its revision; the change keeps the plan's fix round.",
    localDescription:
      'After a planned part\'s last feature, check it against its plan (planId): size, holes, a step or more tagged with each planned feature, closed body, thinnest wall, and a closed floor when the plan sets one. A plan with printInPlace also gets pieces and gaps (gap sizes in the plan too), only after geom.fit_check has run on the design as it is now. Fix failed items once and check again; on stop, stop building and tell the person what is off. Give design when asked. More: kb.search "design check".',
    input: z.object({
      planId: z.string().min(1).describe('The planId of the plan the part was built from'),
      design: z.string().min(1).optional().describe('The design id the part was built in, when the plan is not tied to one; it ties the plan to it, except a plan the person made in the mimir tab, which only the tab ties'),
    }),
    async run(i, ctx) {
      const entry = plans.get(i.planId)
      if (!entry) throw new ToolInputError(`planId: there is no plan ${i.planId}; make the plan first, then build the part and check it`)
      // sizes changed after the plan was approved: it no longer says what the part should be, and once a newer plan was
      // answered it never will
      if (entry.superseded) throw new ToolInputError(supersededPlanNote(entry.plan.part))
      if (entry.stale) throw new ToolInputError(stalePlanNote(entry.plan.part, opts.cardSide === true))
      // the fix round is used: the same answer again, with no new geometry work
      if (entry.closed) return { summary: `Plan ${entry.plan.planId} has had its fix round, so the part was not checked again. Its last check: ${entry.closed.summary}`, output: { ...entry.closed.output, repeated: true } }
      const { design: d, how } = builtFrom(entry, i.design)
      // a print-in-place part is checked once its gaps were looked at, on the part as it is now
      if (entry.plan.printInPlace && entry.plan.printInPlace.length >= 2 && !fitLooked(d, entry.plan.printInPlace))
        throw new ToolInputError(
          // the card's side shows it in the mimir card's step row, in plain words with no tool name or id
          opts.cardSide
            ? `Nothing was checked. ${entry.plan.part} prints in place, so its gaps are looked at first: run the fit check on the design ${d.name} as it is now, with every planned piece, fix any gap it flags, then check again.`
            : `Nothing was checked. ${entry.plan.part} prints in place, so its gaps are looked at first: run geom.fit_check on design ${d.id} as it is now, with every planned piece, fix any gap it flags, then check again.`,
        )
      const nozzleMm = nozzleOr(opts.nozzleMm?.())
      // a plan the person approved on the card whose pieces print together without printInPlace naming them: only its
      // planned gaps are held to the rule, as it names no pieces to measure
      const together = entry.origin === 'card' && printsTogether(entry.plan)
      // the run's machine material, nozzle and layer height under the host's own, as design.plan holds the plan to
      const limits = entry.plan.printInPlace || together ? runFitLimits(ctx?.context, { ...opts.fitProfile?.(), nozzleMm: opts.nozzleMm?.() }) : undefined
      // a part that holds something (its plan sets a floor) has its floor read; the plan's own holes may open through it
      const floor = plannedFloor(entry.plan) ? { plannedHoleMm: plannedHoleMm(entry.plan) } : undefined
      const body = await bodyFacts(designs, d, entry.plan.printInPlace ? limits : undefined, { hook: hasHookLip(entry.plan), nozzleMm, ...(floor ? { floor } : {}), ...(entry.plan.holes?.some((h) => h.recess) ? { recesses: true } : {}) })
      const result = designCheck(entry.plan, body, nozzleMm, limits, together)
      const failed = result.items.filter((x) => !x.pass)
      const which = `${d.name} (${d.id}, ${how})`
      // a passed item can still warn (a wall thin only at a sharp edge, a wall not measured): the summary says so
      const warned = result.items.filter((x) => x.pass && x.warning)
      const warnings = warned.length ? `. Warning: ${warned.map((x) => `${x.name}: ${x.warning}`).join('; ')}` : ''
      const checked = (result.pass ? `${which} matches plan ${entry.plan.planId}: all ${result.items.length} checks pass` : `${which}: ${failed.length} of ${result.items.length} checks against plan ${entry.plan.planId} failed: ${failed.map((x) => `${x.name} (want ${x.want}, got ${x.got})`).join('; ')}`) + warnings
      // an amended plan says which revision it checked, so the build reads the sizes it was held to
      const summary = entry.revision ? `${checked} (plan revision ${entry.revision})` : checked
      const output = { planId: entry.plan.planId, ...(entry.revision ? { revision: entry.revision } : {}), design: d.id, designName: d.name, chosen: how, nozzleMm, ...result, body }
      const open = designs.list().map((x) => x.id)
      // a miss only on how a part of several pieces is named is not the part's fault: once per plan it keeps the fix round
      if (failed.length === 1 && isNamingMiss(failed[0]!) && plans.waiveNaming(entry.plan.planId, open)) return { summary: `${summary}. This miss does not use the fix round.`, output }
      const failedChecks = plans.checked(entry.plan.planId, result.pass, open)
      if (result.pass) return { summary, output }
      // the first miss: the fix round is open, said in the result itself, since a bare list of failed items read as the
      // end of the build and the reply stopped there instead of fixing them
      if (failedChecks <= FIX_ROUNDS) return { summary: `${summary}. ${fixRoundOpen(entry.plan.planId)}`, output }
      // the second miss: one fix round was the limit, so mimir stops here and says what is off
      const stop = `The fix round is used: stop building, and tell the person exactly what is off (each failed item, what the plan wants and what the part has) and ask how to go on. Checking plan ${entry.plan.planId} again returns this same result.`
      const last = { summary: `${summary}. ${stop}`, output: { ...output, stop } }
      plans.close(entry.plan.planId, last)
      return last
    },
  })

  // How an integrator hands design.check a plan: kept in the same registry it reads, as a client plan, with no card to
  // approve. It never replaces or pushes out a plan the person made on the mimir tab's card (design.plan there), and
  // the tab leaves this tool out.
  const plan = defineTool({
    name: 'design.put_plan',
    version: '1.6.0',
    source: 'command',
    permission: 'read',
    description:
      'Add your own part plan for slicerx_design_check to check a built part against, before or after building it. It only adds plans you make here: it cannot change or replace a plan the person made in the mimir tab (that planId is refused), and nothing on the plate or printer changes. The plan is the part as planned: planId, part (its name), units (mm or in), features (each with a name, an optional kind, its sizes and, in kinds, count or angle for each size that is a count or an angle; a size with none is read by its name), and optionally the overall size (x, y and z, z as the print height) and the holes by name and diameter (count for a row of several holes of that diameter, default 1), with assumptions and questions (empty lists for none), and, when pieces of the part print assembled and move (hinges, chains, gears, jointed, articulated or flexi segments), those pieces by name in printInPlace, and, when a piece is meant to be open (the top of a cup, holder or vase), its open faces in openFaces: the piece (the part name, or a piece printInPlace names) and its faces as it prints (top, bottom, front, back, left or right, each once, never all six). Your plan with a planId you already used replaces it; your last 50 plans are kept. design ties the plan to the design the part is built in; without it, slicerx_design_check picks the design named as the part, or the only one open. Returns the planId to check with, and underFloors: each size under the smallest this printer makes (a gap on each side between pieces, held to the side by side gap unless the pieces print in place, with pin and bore when it runs around a pin; a wall or pin under two nozzle lines; a hole under the nozzle), with the floor and why, and unstated when a plan with a hinge or a pin piece does not say whether it prints assembled on its hinge (printInPlace) or laid apart (an assumption), or says both. The plan is kept as given; put it again with the floor to build to it. Once its part is built, a size the build cannot keep is changed with amends (its planId) and reason (why, required): sizes only, once per fix round and never after the stop result; the plan keeps its design and fix round, and the result gives its revision and each change.',
    input: z.object({
      plan: partPlanSchema.omit({ detail: true, curved: true, flat: true, proportions: true, repeats: true, colors: true, scale: true, real: true, tiers: true }).extend({ assumptions: assumptionsInput }).describe('The part plan: planId, part, units, features, optional overall, holes, printInPlace and openFaces, assumptions and questions'),
      design: z.string().min(1).optional().describe('The design id the part is built in, to tie the plan to it'),
      amends: z.string().trim().min(1).max(64).optional().describe("To change your built plan's sizes: its planId, the same as plan.planId; once per fix round"),
      reason: z.string().max(AMEND_REASON_MAX).optional().describe('With amends: why the build changes the plan'),
    }),
    async run(i, ctx) {
      if (plans.get(i.plan.planId)?.origin === 'card') throw new ToolInputError(new PlanOwnedError(i.plan.planId).message)
      const fit = () => planFloors(runFitLimits(ctx?.context, { ...opts.fitProfile?.(), nozzleMm: opts.nozzleMm?.() }))
      if (i.amends !== undefined) return amendPlan(i.plan, i.amends, i.reason, i.design, fit)
      if (i.reason !== undefined) throw new ToolInputError('reason: give a reason only with amends, to change a plan of yours')
      const faces = openFacesProblem(i.plan)
      if (faces) throw new ToolInputError(faces)
      // a tie names a design that exists (get refuses one that does not)
      const tied = i.design ? designs.get(i.design) : undefined
      plans.put(i.plan, tied?.id, 'client')
      const p = i.plan
      const holes = (p.holes ?? []).reduce((n, h) => n + (h.count ?? 1), 0)
      const open = (p.openFaces ?? []).map((o) => `${o.piece} open at the ${o.faces.join(' and ')}`)
      const shape = [plural(p.features.length, 'feature'), ...(holes ? [plural(holes, 'hole')] : []), ...(p.overall ? [`${p.overall.x} x ${p.overall.y} x ${p.overall.z} ${p.units} overall`] : []), ...open].join(', ')
      // sizes under the printer's floors are named, not changed: the client's plan is its own
      const under = underFloors(p, fit())
      const floors = underText(under, p.units)
      // a hinge or pin plan that does not say how it prints is kept, with what it leaves the build to guess
      const unstated = jointProblem(p)
      const say = unstated ? ` The plan has a hinge or pin but does not say ${unstated === LID_STATEMENT ? '' : 'one way '}how it prints: ${unstated}.` : ''
      return {
        summary: `Kept plan ${p.planId} for ${p.part} (${shape})${tied ? `, tied to ${tied.name} (${tied.id})` : ''}.${floors}${say} Build it, then check it with design.check and planId ${p.planId}.`,
        output: {
          planId: p.planId,
          part: p.part,
          ...(tied ? { design: tied.id } : {}),
          features: p.features.length,
          holes,
          ...(unstated ? { unstated } : {}),
          ...(p.openFaces ? { openFaces: p.openFaces } : {}),
          underFloors: under.map(underOut),
        },
      }
    },
  })

  /**
   * design.put_plan with amends: a client's built plan takes new sizes under its planId (plan-amend.ts), with its design
   * tie and fix round as they were, and its revision goes up by one. Sizes under the printer's floors are named, as a
   * new client plan's are, and kept as given.
   */
  function amendPlan(given: PartPlan, planId: string, reason: string | undefined, design: string | undefined, fit: () => PlanFloors): ToolOutput {
    const why = amendReason(reason)
    if ('problem' in why) throw new ToolInputError(why.problem)
    if (given.planId !== planId) throw new ToolInputError(`amends: give the plan with the planId it amends; plan.planId is ${given.planId}, amends is ${planId}`)
    const entry = plans.get(planId)
    const problem = amendProblem(planId, entry, 'client')
    if (problem) throw new ToolInputError(problem)
    if (design !== undefined && design !== entry!.design) throw new ToolInputError(`design: an amend keeps the plan's design, ${entry!.design}`)
    const shape = amendShapeProblem(entry!.plan, given)
    if (shape) throw new ToolInputError(shape)
    const changes = amendChanges(entry!.plan, given)
    if (!changes.length) throw new ToolInputError(`amends: no size differs from plan ${planId}`)
    const p = amendedSizes(entry!.plan, given)
    plans.put(p, entry!.design, 'client')
    const revision = plans.amended(planId, why.why)
    const under = underFloors(p, fit())
    return {
      summary: `Changed plan ${planId} for ${p.part} (revision ${revision}): ${changes.map((c) => changeText(c, p.units)).join(', ')}.${underText(under, p.units)} Build to it as changed, then check it with design.check and planId ${planId}.`,
      output: { planId, part: p.part, design: entry!.design!, revision, changes, underFloors: under.map(underOut) },
    }
  }

  return [create, open, list, steps, edit, undo, redo, timeline, roll, save, check, plan] as PilotTool<never>[]
}

/** Sizes under the printer's floors in the result's words, for a plan kept as the client gave it. */
function underText(under: UnderFloor[], units: 'mm' | 'in'): string {
  return under.length ? ` ${under.map((u) => underLine(u, units)).join('; ')}. Put the plan again with ${under.length === 1 ? 'that size' : 'those sizes'} raised for a part that prints.` : ''
}

/** A size under its floor as design.put_plan returns it. */
function underOut(u: UnderFloor) {
  return { feature: u.feature, size: u.feature === null ? `${u.hole} ${u.size}` : u.size, planned: u.planned, floor: u.floor, why: u.why, ...(u.bore !== undefined ? { pin: u.pin!, bore: u.bore } : {}) }
}
