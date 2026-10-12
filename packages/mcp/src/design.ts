// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs: a part a client models step by step, kept as the same CAD history a person's edits make
// (@slicerx/cad-history, docs/cad-history.md). Each modeling tool given a `design` adds one step and replays it
// on the engine, so a saved design opens in SlicerX with every step editable. A new step that fails is dropped
// and its reason returned: a design never keeps a broken edit the client did not ask for.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORY_VERSION, IDENTITY, appendStep, bakeMesh, historyFiles, parseHistories, replayHistory, stepId, type DesignHost, type EngineCall, type History, type HistoryMesh, type Mat4, type Step, type StepParams, type StepStatus } from '@slicerx/cad-history'
import { soup, slug, type Design, type DesignFiles } from './design-tools'
import { writeBinaryStl, readStlPositions } from './mesh'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import { readFileObjects, type FilePart } from './threemf'
import { readZip, writeZip } from './zip'

export { designArg, designSummary, designTools, faceAt, item, partAt, type Design, type DesignFiles } from './design-tools'

export interface DesignDeps {
  engine: EngineCall
  policy: PathPolicy
}

/** Keeps the designs of this server, and runs their steps: the MCP server's design host. */
export class Designs implements DesignHost {
  private readonly all = new Map<string, Design>()
  private seq = 0

  constructor(readonly deps: DesignDeps) {}

  call(op: string, request: unknown): Promise<unknown> {
    return this.deps.engine(op, request)
  }

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
    const d: Design = { id, name, history: history ?? { version: HISTORY_VERSION, base, steps: [] }, transform, parts: base, status: [], madeBy: {}, written: 0, redo: [] }
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
    d.redo = []
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
    d.written = (d.written ?? 0) + 1
    const file = join(dir, `${slug(d.name)}-${d.written}.stl`)
    writeFileSync(file, writeBinaryStl(soup(d.parts.map((p) => bakeMesh(p, d.transform)))))
    d.stl = file
  }
}

function withBroken(s: Step, st: StepStatus | undefined): Step {
  const { broken: _b, note: _n, ...rest } = s
  return { ...rest, ...(st?.state === 'broken' ? { broken: st.message ?? 'The step failed.' } : {}), ...(st?.note ? { note: st.note } : {}) }
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

/** The paint attributes Bambu Studio and OrcaSlicer write on a painted triangle, by layer. */
const PAINT_ATTR = { color: 'paint_color', seam: 'paint_seam', support: 'paint_supports', fuzzy: 'paint_fuzzy_skin' } as const

/** A triangle's paint as 3MF attributes (none when it is not painted), so every slicer sees the colors. */
function paintAttrs(p: HistoryMesh, t: number): string {
  if (!p.paint) return ''
  let out = ''
  for (const [layer, attr] of Object.entries(PAINT_ATTR) as [keyof typeof PAINT_ATTR, string][]) {
    const text = p.paint[layer]?.[t]
    if (text && /^[0-9A-Fa-f]+$/.test(text)) out += ` ${attr}="${text}"`
  }
  return out
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
      for (let k = 0; k + 2 < p.indices.length; k += 3) t.push(`<triangle v1="${p.indices[k]}" v2="${p.indices[k + 1]}" v3="${p.indices[k + 2]}"${paintAttrs(p, k / 3)}/>`)
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

/**
 * The objects of a 3MF as designs to open: those with a SlicerX CAD history keep it, the others start from their
 * printed parts (component transforms baked in, slots and paint kept) with no steps yet.
 */
export function readDesigns(buf: Buffer, label: string): { name: string; transform: Mat4; history?: History; base: FilePart[]; skipped: string[] }[] {
  const zip = readZip(buf, label)
  if (zip.text('3D/3dmodel.model') === undefined) throw new ToolInputError(`${label} is not a 3MF project: it has no 3D/3dmodel.model`, 'unsupported_format')
  const objects = readFileObjects(zip, label)
  const files = new Map<string, Uint8Array>()
  for (const n of zip.names()) if (n.startsWith('Metadata/slicerx_history')) files.set(n, zip.read(n) ?? new Uint8Array())
  const histories = parseHistories(files, new Set(objects.map((o) => o.id)))
  return objects.map((o) => {
    const h = histories.get(o.id)
    return { name: o.name, transform: o.transform, ...(h ? { history: h } : {}), base: o.parts, skipped: o.skipped }
  })
}

/** The server's files for the design tools: models from paths, URLs and samples, 3MF files in the output folder. */
export function designFiles(policy: PathPolicy): DesignFiles {
  return {
    async model(from, name) {
      return [stlMesh(readFileSync(await resolveModel(policy, from)), name)]
    },
    async open(path) {
      return readDesigns(readFileSync(await resolveModel(policy, path)), path)
    },
    async save(d, fileName) {
      const dir = join(policy.outDir, 'designs')
      mkdirSync(dir, { recursive: true })
      const base = slug((fileName ?? d.name).replace(/\.3mf$/i, ''))
      const path = join(dir, `${base}.3mf`)
      const bytes = design3mf(d)
      writeFileSync(path, bytes)
      return { path, bytes: bytes.length }
    },
  }
}
