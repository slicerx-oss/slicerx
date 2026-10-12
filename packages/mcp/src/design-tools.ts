// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The design tools and what they read back, on any design host (cad-history host.ts): the MCP server's designs
// (design.ts) or the app's plate. No Node imports, so the app runs the same definitions; files come through
// DesignFiles, which only the server has.
import { bakeMesh, keyOfTriangle, mainNumber, replayHistory, stepName, withNumber, type Design as HostDesign, type DesignHost, type History, type HistoryMesh, type Mat4, type Step } from '@slicerx/cad-history'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { productName } from '@slicerx/contracts'
import { ToolInputError } from './errors'
import { meshStats } from './mesh'
import type { FilePart } from './threemf'

type V3 = [number, number, number]

/** A design on this server: the host's design (cad-history host.ts), plus the STL files it writes. */
export interface Design extends HostDesign {
  /** The STL of the parts after the last change, in the output folder. */
  stl?: string
  /** How many STL files this design has written, for their names. */
  written?: number
}

export const designArg = z.string().min(1).describe('A design id from slicerx_design_new or slicerx_design_open')

/** The files the design tools read and write. The app has none: its designs open and save with the project. */
export interface DesignFiles {
  /** The parts of a model (an STL path, URL or sample: name) to start a design from. */
  model(from: string, name: string): Promise<HistoryMesh[]>
  /** The objects of a 3MF to open as designs, with their history when they have one. */
  open(path: string): Promise<{ name: string; transform: Mat4; history?: History; base: HistoryMesh[]; skipped: string[] }[]>
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
  if (normal && hit.score < Math.cos((10 * Math.PI) / 180)) throw new ToolInputError('normal: no face at that point faces that way; give the outward normal of the face you mean')
  const key = keyOfTriangle(parts[hit.part]!, hit.triangle)
  return { part: hit.part, triangle: hit.triangle, normal: hit.normal, key: key || undefined }
}

/** The parts as they were right after `step` (an index from 1, an id or a step's name); the latest parts without one. */
export async function partsAt(host: DesignHost, d: HostDesign, step?: number | string): Promise<HistoryMesh[]> {
  if (step === undefined) return d.parts
  const k = stepIndex(d, step)
  if (k === d.history.steps.length - 1) return d.parts
  const r = await replayHistory((op, request) => host.call(op, request), { history: { ...d.history, steps: d.history.steps.slice(0, k + 1) } })
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
  return { mesh: { positions: Array.from(p.positions), indices: Array.from(p.indices), ...(p.faces ? { faces: p.faces } : {}) }, transform: d.transform }
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

/** What a client reads back after every change: the parts with their sizes and volumes, and the last step. */
export function designSummary(d: Design): Record<string, unknown> {
  const parts = d.parts.map((p, i) => {
    const s = meshStats(soup([bakeMesh(p, d.transform)]))
    const paint = (p as FilePart).paint
    const painted = paint ? Object.fromEntries(Object.entries(paint).map(([k, v]) => [k, Object.keys(v ?? {}).length])) : undefined
    return { index: i, name: p.name, slot: p.slot, triangles: s.triangles, minMm: s.minMm, sizeMm: s.bboxMm, volumeMm3: r3(s.volumeMm3), ...(painted ? { paintedTriangles: painted } : {}) }
  })
  const all = d.parts.length ? meshStats(soup(d.parts.map((p) => bakeMesh(p, d.transform)))) : null
  const last = d.history.steps.length ? stepRow(d, d.history.steps.length - 1) : null
  return {
    design: d.id,
    name: d.name,
    steps: d.history.steps.length,
    ...(last ? { lastStep: last } : {}),
    ...(all ? { minMm: all.minMm, sizeMm: all.bboxMm } : {}),
    volumeMm3: r3(parts.reduce((s, p) => s + p.volumeMm3, 0)),
    parts,
    ...(d.stl ? { stlPath: d.stl } : {}),
    ...(d.history.ended ? { ended: d.history.ended } : {}),
  }
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

/** The design tools on a host; `files` reads the models design.new starts from and the 3MF files design.open and design.save use. */
export function designTools(designs: DesignHost, files: DesignFiles): PilotTool<never>[] {
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

  const create = defineTool({
    name: 'design.new',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      `Start a design: a part you build step by step with the modeling tools (slicerx_geom_extrude, slicerx_geom_revolve, slicerx_geom_push_pull, slicerx_geom_fillet, slicerx_geom_chamfer, slicerx_geom_build, slicerx_geom_subtract, slicerx_geom_hollow, slicerx_geom_emboss, slicerx_geom_repair), each given this design id. Every step lands in the design's editable history, the same one ${productName()} keeps for a person, so slicerx_design_save writes a 3MF that opens with every step editable. Start empty (the first step makes a body) or from an STL. Units are mm, Z up, the bed at Z = 0.`,
    input: z.object({
      name: z.string().min(1).max(120).default('Design'),
      from: z.string().min(1).optional().describe('Start from this model: an STL path, URL or sample: name. Absent: an empty design'),
    }),
    async run(i) {
      const base = i.from ? await files.model(i.from, i.name) : []
      const d = await designs.create(i.name, base)
      return { summary: `Started ${d.name} (${d.id})${base.length ? ' from the model' : ''}`, output: designSummary(d) }
    },
  })

  const open = defineTool({
    name: 'design.open',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description:
      `Open the objects of any 3MF project (${productName()}, Bambu Studio, Orca) as designs, one per object. An object with a ${productName()} CAD history opens with its steps replayed; any other starts from its printed parts, with their filament slots and paint, and no steps yet. Modifiers and other volumes are left out and named.`,
    input: z.object({ path: z.string().min(1).describe('Path of the .3mf file') }),
    async run(i) {
      const found = await files.open(i.path)
      if (!found.length) throw new ToolInputError(`${i.path} has no printed parts to open`)
      const opened = []
      for (const f of found) opened.push({ ...designSummary(await designs.create(f.name, f.history?.base ?? f.base, f.history, f.transform)), fromHistory: f.history !== undefined, ...(f.skipped.length ? { leftOut: f.skipped } : {}) })
      return { summary: `Opened ${plural(opened.length, 'design')}`, output: { designs: opened } }
    },
  })

  const list = defineTool({
    name: 'design.list',
    version: '1.0.0',
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
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'The steps of a design in order: each one\'s index, id, name ("Pull 5 mm", "Fillet 0.5 mm"), its main number, and whether it went through, broke (with the reason) or is suppressed.',
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
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      `Edit one step of a design and replay the steps after it, as editing a step in ${productName()}'s history does: set its main number (the distance, depth, angle, radius, wall or diameter slicerx_design_steps shows as value), suppress it or turn it back on, or rename it. Steps after it that no longer work are reported broken with the reason; edit them, or edit this one back.`,
    input: z.object({
      design: designArg,
      step: z.union([z.number().int().min(1), z.string().min(1)]).describe('Index from 1, or a step id'),
      value: z.number().min(-10_000).max(10_000).optional().describe('The new main number'),
      suppressed: z.boolean().optional(),
      label: z.string().max(120).optional().describe('A name for the step; empty for the one made from its numbers'),
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
        next = { ...next, params: p }
      }
      if (i.suppressed !== undefined) {
        const { suppressed: _s, ...rest } = next
        next = i.suppressed ? { ...rest, suppressed: true } : rest
      }
      if (i.label !== undefined) {
        const { label: _l, ...rest } = next
        next = i.label.trim() ? { ...rest, label: i.label.trim() } : rest
      }
      const { broken: _b, ...clean } = next
      d.history = { ...d.history, steps: d.history.steps.map((x, j) => (j === k ? clean : x)) }
      await designs.replay(d)
      const rows = d.history.steps.map((_, j) => stepRow(d, j))
      const broken = rows.filter((r) => r['state'] === 'broken')
      return { ok: broken.length === 0, summary: `Edited step ${k + 1}, ${stepName(clean)}${broken.length ? `; step ${String(broken[0]!['index'])} broke: ${String(broken[0]!['message'] ?? '')}` : ''}`, output: { ...designSummary(d), steps: rows } }
    },
  })

  const undo = defineTool({
    name: 'design.undo',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Remove the last step of a design and replay it, back to how it was before that step.',
    input: z.object({ design: designArg }),
    async run(i) {
      const d = designs.get(i.design)
      const last = d.history.steps[d.history.steps.length - 1]
      if (!last) throw new ToolInputError('The design has no steps to undo.')
      d.history = { ...d.history, steps: d.history.steps.slice(0, -1) }
      d.redo.push(last)
      // Every host replays, even to no steps: the app's takes the body off the plate then.
      await designs.replay(d)
      return { summary: `Removed ${stepName(last)}`, output: designSummary(d) }
    },
  })

  const redo = defineTool({
    name: 'design.redo',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Put back the step slicerx_design_undo last removed. A new step clears what can be redone.',
    input: z.object({ design: designArg }),
    async run(i) {
      const d = designs.get(i.design)
      const step = d.redo.pop()
      if (!step) throw new ToolInputError('Nothing to redo.')
      d.history = { ...d.history, steps: [...d.history.steps, step] }
      await designs.replay(d)
      return { summary: `Put back ${stepName(step)}`, output: designSummary(d) }
    },
  })

  const save = defineTool({
    name: 'design.save',
    version: '1.0.0',
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

  return [create, open, list, steps, edit, undo, redo, save] as PilotTool<never>[]
}
