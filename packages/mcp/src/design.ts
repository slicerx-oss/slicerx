// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs: a part a client models step by step, kept as the same CAD history a person's edits make
// (@slicerx/cad-history, docs/cad-history.md). Each modeling tool given a `design` adds one step and replays it
// on the engine, so a saved design opens in SlicerX with every step editable. A new step that fails is dropped
// and its reason returned: a design never keeps a broken edit the client did not ask for.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HISTORY_VERSION,
  IDENTITY,
  appendStep,
  bakeMesh,
  historyFiles,
  keyOfTriangle,
  mainNumber,
  parseHistories,
  replayHistory,
  stepId,
  stepName,
  withNumber,
  type EngineCall,
  type History,
  type HistoryMesh,
  type Mat4,
  type Step,
  type StepParams,
  type StepStatus,
} from '@slicerx/cad-history'
import { defineTool, type PilotTool } from '@slicerx/pilot'
import { z } from 'zod'
import { meshStats, readStlPositions, writeBinaryStl } from './mesh'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import { readZip, writeZip } from './zip'

type V3 = [number, number, number]

export interface Design {
  id: string
  name: string
  history: History
  /** The object's transform: the frame of every point a client gives and gets. Identity unless a file set one. */
  transform: Mat4
  /** The parts after the last replay, in the object's own frame. */
  parts: HistoryMesh[]
  status: StepStatus[]
  /** The step that made each face, by face key. */
  madeBy: Record<number, string>
  /** The STL of the parts after the last change, in the output folder. */
  stl?: string
  /** How many STL files this design has written, for their names. */
  written: number
}

export interface DesignDeps {
  engine: EngineCall
  policy: PathPolicy
}

export const designArg = z.string().min(1).describe('A design id from slicerx_design_new or slicerx_design_open')

/** Keeps the designs of this server, and runs their steps. */
export class Designs {
  private readonly all = new Map<string, Design>()
  private seq = 0

  constructor(readonly deps: DesignDeps) {}

  get(id: string): Design {
    const d = this.all.get(id)
    if (!d) throw new ToolInputError(`design: no design ${id}; slicerx_design_list lists them`, 'not_found')
    return d
  }

  list(): Design[] {
    return [...this.all.values()]
  }

  async create(name: string, base: HistoryMesh[], history?: History, transform: Mat4 = [...IDENTITY]): Promise<Design> {
    const id = `d${++this.seq}`
    const d: Design = { id, name, history: history ?? { version: HISTORY_VERSION, base, steps: [] }, transform, parts: base, status: [], madeBy: {}, written: 0 }
    if (d.history.steps.length) await this.replay(d)
    else this.export(d)
    this.all.set(id, d)
    return d
  }

  /** Adds a step on part `part` (-1 for every part) and keeps it only when it goes through. */
  async add(d: Design, part: number, params: StepParams, label?: string): Promise<Step> {
    const step: Step = { id: stepId(), part, transform: [...d.transform], params, ...(label ? { label } : {}) }
    const history = appendStep(d.history, step)
    const r = await replayHistory(this.deps.engine, { history })
    const st = r.status[r.status.length - 1]
    if (st?.state !== 'done') throw new ToolInputError(`The step did not go through: ${st?.message ?? 'the steps before it are broken'}. The design is unchanged.`, 'invalid_input', { design: d.id })
    this.keep(d, history, r)
    return history.steps[history.steps.length - 1]!
  }

  /** Replays the design as it is, after an edit of its steps. */
  async replay(d: Design): Promise<void> {
    const r = await replayHistory(this.deps.engine, { history: d.history })
    this.keep(d, d.history, r)
  }

  private keep(d: Design, history: History, r: Awaited<ReturnType<typeof replayHistory>>): void {
    // A step that broke keeps its sentence, as the app shows it.
    d.history = { ...history, steps: history.steps.map((s, i) => withBroken(s, r.status[i])) }
    d.parts = r.parts
    d.status = r.status
    d.madeBy = r.madeBy ?? {}
    this.export(d)
  }

  /** Writes the parts as one STL in the object's frame, so slicing and the mesh tools can take the result. */
  private export(d: Design): void {
    if (!d.parts.length) return
    const dir = join(this.deps.policy.outDir, 'designs', d.id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${slug(d.name)}-${++d.written}.stl`)
    writeFileSync(file, writeBinaryStl(soup(d.parts.map((p) => bakeMesh(p, d.transform)))))
    d.stl = file
  }

  /** The part and triangle under a point on a face (world), facing `normal` when given. */
  faceAt(d: Design, at: V3, normal?: V3): { part: number; triangle: number; normal: V3; key: number | undefined } {
    let best: { part: number; triangle: number; normal: V3; score: number } | null = null
    d.parts.forEach((p, part) => {
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
    if (normal && hit.score < Math.cos((2 * Math.PI) / 180)) throw new ToolInputError('normal: no face at that point faces that way; give the outward normal of the face you mean')
    const key = keyOfTriangle(d.parts[hit.part]!, hit.triangle)
    return { part: hit.part, triangle: hit.triangle, normal: hit.normal, key: key || undefined }
  }

  /** The part whose surface holds a point (world), or the first part when none is near. */
  partAt(d: Design, at: V3): number {
    for (const [i, p] of d.parts.entries()) {
      const w = bakeMesh(p, d.transform)
      for (let t = 0; t + 2 < w.indices.length; t += 3) if (distance(at, corners(w, t)) <= NEAR_MM) return i
    }
    return 0
  }

  /** A part as an engine mesh item, with the object's transform. */
  item(d: Design, part: number): { mesh: { positions: number[]; indices: number[]; faces?: unknown }; transform: Mat4 } {
    const p = d.parts[part]
    if (!p) throw new ToolInputError(`part: the design has ${d.parts.length} part${d.parts.length === 1 ? '' : 's'}`)
    return { mesh: { positions: Array.from(p.positions), indices: Array.from(p.indices), ...(p.faces ? { faces: p.faces } : {}) }, transform: d.transform }
  }
}

function withBroken(s: Step, st: StepStatus | undefined): Step {
  const { broken: _b, note: _n, ...rest } = s
  return { ...rest, ...(st?.state === 'broken' ? { broken: st.message ?? 'The step failed.' } : {}), ...(st?.note ? { note: st.note } : {}) }
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
function soup(parts: readonly Pick<HistoryMesh, 'positions' | 'indices'>[]): Float32Array {
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

/** An STL's triangles as an indexed mesh, with corners at the same place joined. */
export function stlMesh(buf: Buffer, name: string): HistoryMesh {
  const pos = readStlPositions(buf)
  const at = new Map<string, number>()
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i + 2 < pos.length; i += 3) {
    const x = pos[i] ?? 0
    const y = pos[i + 1] ?? 0
    const z = pos[i + 2] ?? 0
    const k = `${x},${y},${z}`
    let v = at.get(k)
    if (v === undefined) {
      v = positions.length / 3
      at.set(k, v)
      positions.push(x, y, z)
    }
    indices.push(v)
  }
  if (!indices.length) throw new ToolInputError(`${name}: the model has no triangles`)
  return { name, slot: 1, positions, indices }
}

const slug = (s: string): string => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'design'
const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** What a client reads back after every change: the parts with their sizes and volumes, and the last step. */
export function designSummary(d: Design): Record<string, unknown> {
  const parts = d.parts.map((p, i) => {
    const s = meshStats(soup([bakeMesh(p, d.transform)]))
    return { index: i, name: p.name, slot: p.slot, triangles: s.triangles, minMm: s.minMm, sizeMm: s.bboxMm, volumeMm3: r3(s.volumeMm3) }
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

/** The step a client names: its 1-based index or its id. */
function stepIndex(d: Design, step: number | string): number {
  const i = typeof step === 'number' ? step - 1 : d.history.steps.findIndex((s) => s.id === step)
  if (i < 0 || i >= d.history.steps.length) throw new ToolInputError(`step: the design has ${d.history.steps.length} step${d.history.steps.length === 1 ? '' : 's'}; give an index from 1 or a step id from slicerx_design_steps`)
  return i
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (v: number): string => String(Math.fround(v))

/** 3MF row-major 3x4 transform from a column-major Mat4. */
const transformAttr = (m: Mat4): string => [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((i) => num(m[i] ?? 0)).join(' ')

/**
 * A design as a 3MF project: one object whose parts are components with their filament slots (Orca and Bambu
 * Studio's model_settings.config), and the CAD history beside it (Metadata/slicerx_history.json).
 */
export function design3mf(d: Design): Buffer {
  if (!d.parts.length) throw new ToolInputError('The design has no parts yet; add a step that makes a body first.')
  const n = d.parts.length
  const objectId = n + 1
  const meshes = d.parts
    .map((p, i) => {
      const v: string[] = []
      for (let k = 0; k + 2 < p.positions.length; k += 3) v.push(`<vertex x="${num(p.positions[k]!)}" y="${num(p.positions[k + 1]!)}" z="${num(p.positions[k + 2]!)}"/>`)
      const t: string[] = []
      for (let k = 0; k + 2 < p.indices.length; k += 3) t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"/>`)
      return `<object id="${i + 1}" type="model" name="${esc(p.name)}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`
    })
    .join('')
  const components = d.parts.map((_, i) => `<component objectid="${i + 1}"/>`).join('')
  const identity = d.transform.every((v, i) => v === IDENTITY[i])
  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">SlicerX</metadata><resources>${meshes}` +
    `<object id="${objectId}" type="model" name="${esc(d.name)}"><components>${components}</components></object></resources>` +
    `<build><item objectid="${objectId}"${identity ? '' : ` transform="${transformAttr(d.transform)}"`} printable="1"/></build></model>`
  const meta = (k: string, v: string | number): string => `<metadata key="${k}" value="${esc(String(v))}"/>`
  const settings =
    `<?xml version="1.0" encoding="UTF-8"?>\n<config><object id="${objectId}">${meta('name', d.name)}${meta('extruder', d.parts[0]!.slot)}` +
    d.parts.map((p, i) => `<part id="${i + 1}" subtype="normal_part">${meta('name', p.name)}${meta('extruder', p.slot)}</part>`).join('') +
    `</object></config>`
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/><Default Extension="json" ContentType="application/json"/><Default Extension="bin" ContentType="application/octet-stream"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    },
    { name: '3D/3dmodel.model', data: model },
    { name: 'Metadata/model_settings.config', data: settings },
    ...historyFiles([{ id: d.id, history: d.history }], new Map([[d.id, objectId]])),
  ])
}

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w:]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]))

/** A 3MF transform attribute (row-major 3x4) as a column-major Mat4. */
function matOf(attr: string | undefined): Mat4 {
  const v = attr?.trim().split(/\s+/).map(Number)
  if (!v || v.length !== 12 || v.some((x) => !Number.isFinite(x))) return [...IDENTITY]
  return [v[0]!, v[1]!, v[2]!, 0, v[3]!, v[4]!, v[5]!, 0, v[6]!, v[7]!, v[8]!, 0, v[9]!, v[10]!, v[11]!, 1]
}

/** The objects of a 3MF with a CAD history: their file id, name, transform and history. Objects without one are named in `without`. */
export function readDesigns(buf: Buffer, label: string): { found: { name: string; transform: Mat4; history: History }[]; without: string[] } {
  const zip = readZip(buf, label)
  const model = zip.text('3D/3dmodel.model')
  if (!model) throw new ToolInputError(`${label} is not a 3MF project: it has no 3D/3dmodel.model`, 'unsupported_format')
  const names = new Map<string, string>()
  for (const m of model.matchAll(/<object\b[^>]*>/g)) {
    const a = attrs(m[0])
    if (a['id']) names.set(a['id'], a['name'] ?? `Object ${a['id']}`)
  }
  const items = [...model.matchAll(/<item\b[^>]*\/?>/g)].map((m) => attrs(m[0])).filter((a) => a['objectid'])
  const files = new Map<string, Uint8Array>()
  for (const n of zip.names()) if (n.startsWith('Metadata/slicerx_history')) files.set(n, zip.read(n) ?? new Uint8Array())
  const histories = parseHistories(files, new Set(items.map((a) => a['objectid']!)))
  const found: { name: string; transform: Mat4; history: History }[] = []
  const without: string[] = []
  for (const a of items) {
    const id = a['objectid']!
    const h = histories.get(id)
    const name = names.get(id) ?? `Object ${id}`
    if (h) found.push({ name, transform: matOf(a['transform']), history: h })
    else without.push(name)
  }
  return { found, without }
}

export function designTools(designs: Designs): PilotTool<never>[] {
  const { policy } = designs.deps
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

  const create = defineTool({
    name: 'design.new',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description:
      'Start a design: a part you build step by step with the modeling tools (slicerx_geom_extrude, slicerx_geom_revolve, slicerx_geom_push_pull, slicerx_geom_fillet, slicerx_geom_chamfer, slicerx_geom_build, slicerx_geom_subtract, slicerx_geom_hollow, slicerx_geom_emboss, slicerx_geom_repair), each given this design id. Every step lands in the design\'s editable history, the same one SlicerX keeps for a person, so slicerx_design_save writes a 3MF that opens with every step editable. Start empty (the first step makes a body) or from an STL. Units are mm, Z up, the bed at Z = 0.',
    input: z.object({
      name: z.string().min(1).max(120).default('Design'),
      from: z.string().min(1).optional().describe('Start from this model: an STL path, URL or sample: name. Absent: an empty design'),
    }),
    async run(i) {
      const base = i.from ? [stlMesh(readFileSync(await resolveModel(policy, i.from)), i.name)] : []
      const d = await designs.create(i.name, base)
      return { summary: `Started ${d.name} (${d.id})${base.length ? ' from the model' : ''}`, output: designSummary(d) }
    },
  })

  const open = defineTool({
    name: 'design.open',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'Open the designs in a 3MF project that carry a SlicerX CAD history (saved by slicerx_design_save or by SlicerX), with their steps replayed. Returns a design id per object; objects without a history are listed by name.',
    input: z.object({ path: z.string().min(1).describe('Path of the .3mf file') }),
    async run(i) {
      const path = await resolveModel(policy, i.path)
      const { found, without } = readDesigns(readFileSync(path), i.path)
      if (!found.length) throw new ToolInputError(`${i.path} has no object with a SlicerX CAD history${without.length ? ` (${without.join(', ')})` : ''}; start a design from an STL with slicerx_design_new instead`)
      const opened = []
      for (const f of found) opened.push(designSummary(await designs.create(f.name, f.history.base, f.history, f.transform)))
      return { summary: `Opened ${plural(opened.length, 'design')}`, output: { designs: opened, ...(without.length ? { withoutHistory: without } : {}) } }
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
      'Edit one step of a design and replay the steps after it, as editing a step in SlicerX\'s history does: set its main number (the distance, depth, angle, radius, wall or diameter slicerx_design_steps shows as value), suppress it or turn it back on, or rename it. Steps after it that no longer work are reported broken with the reason; edit them, or edit this one back.',
    input: z.object({
      design: designArg,
      step: z.union([z.number().int().min(1), z.string().min(1)]).describe('Index from 1, or a step id'),
      value: z.number().optional().describe('The new main number'),
      suppressed: z.boolean().optional(),
      label: z.string().max(120).optional().describe('A name for the step; empty for the one made from its numbers'),
    }),
    async run(i) {
      const d = designs.get(i.design)
      const k = stepIndex(d, i.step)
      const s = d.history.steps[k]!
      let next: Step = s
      if (i.value !== undefined) {
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
      if (d.history.steps.length) await designs.replay(d)
      else {
        d.parts = d.history.base
        d.status = []
        d.madeBy = {}
      }
      return { summary: `Removed ${stepName(last)}`, output: designSummary(d) }
    },
  })

  const save = defineTool({
    name: 'design.save',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'Save a design as a 3MF project in the output folder: the parts with their filament slots, and the CAD history, so the file opens in SlicerX with every step editable (other slicers open the parts). Also writes the parts as one STL.',
    input: z.object({ design: designArg, file_name: z.string().min(1).max(120).optional().describe('File name without folders; default the design name') }),
    async run(i) {
      const d = designs.get(i.design)
      if (i.file_name && /[\\/]/.test(i.file_name)) throw new ToolInputError('file_name: a name only, without folders; the file goes to the output folder')
      const dir = join(policy.outDir, 'designs')
      mkdirSync(dir, { recursive: true })
      const base = slug((i.file_name ?? d.name).replace(/\.3mf$/i, ''))
      const path = join(dir, `${base}.3mf`)
      const bytes = design3mf(d)
      writeFileSync(path, bytes)
      return { summary: `Saved ${d.name}, ${plural(d.history.steps.length, 'step')}, to ${path}`, output: { path, bytes: bytes.length, ...designSummary(d) } }
    },
  })

  return [create, open, list, steps, edit, undo, save] as PilotTool<never>[]
}
