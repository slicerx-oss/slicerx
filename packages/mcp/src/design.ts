// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Designs: a part a client models step by step, kept as the same CAD history a person's edits make
// (@slicerx/cad-history, docs/cad-history.md). Each modeling tool given a `design` adds one step and replays it
// on the engine, so a saved design opens in SlicerX with every step editable. A new step that fails is dropped
// and its reason returned: a design never keeps a broken edit the client did not ask for.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HISTORY_VERSION, IDENTITY, appendStep, bakeMesh, parseHistories, replayHistory, stepId, type DesignHost, type EngineCall, type History, type HistoryMesh, type Mat4, type PaintTexts, type Step, type StepParams, type StepStatus } from '@slicerx/cad-history'
import { soup, slug, type Design, type DesignFiles } from './design-tools'
import { writeBinaryStl, readStlPositions } from './mesh'
import { resolveModel, ToolInputError, type PathPolicy } from './models'
import { readZip, writeZip } from './zip'
import { BodyRevisions } from '@slicerx/cad-history/body-revisions'
import { productName } from '@slicerx/contracts'
import { entryData, projectFiles } from '@slicerx/threemf'

export { designArg, designSummary, designTools, faceAt, item, partAt, type Design, type DesignFiles } from './design-tools'

export interface DesignDeps {
  engine: EngineCall
  policy: PathPolicy
}

/** Keeps the designs of this server, and runs their steps: the MCP server's design host. */
export class Designs implements DesignHost {
  private readonly all = new Map<string, Design>()
  private seq = 0
  private readonly revisions = new BodyRevisions()

  constructor(readonly deps: DesignDeps) {}

  revision(id: string): string {
    this.get(id)
    return this.revisions.current(id)
  }

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

  async create(name: string, base: HistoryMesh[], history?: History, transform: Mat4 = [...IDENTITY], options?: { exact?: boolean }): Promise<Design> {
    const exact = history?.exact || options?.exact
    if (exact) {
      if (process.env['SX_BREP_DEV'] !== '1') throw new ToolInputError('Exact designs require the developer opt-in SX_BREP_DEV=1.')
      if ((history?.base ?? base).length) throw new ToolInputError('Exact designs start from native features. Imported meshes cannot be converted by this option.')
      const count = await this.deps.engine('brep.count', {}) as { bodies?: number }
      if (!count || !Number.isInteger(count.bodies) || count.bodies! < 0) throw new ToolInputError('The exact kernel did not return its body count.')
    }
    const id = `d${++this.seq}`
    const source = history ?? { version: HISTORY_VERSION, base, steps: [] }
    const d: Design = { id, name, history: exact ? { ...source, exact: true } : source, transform, parts: base, status: [], madeBy: {}, written: 0, redo: [] }
    if (d.history.steps.length) await this.replay(d)
    else { this.export(d); this.revisions.register(id) }
    this.all.set(id, d)
    return d
  }

  /** Adds a step on part `part` (-1 for every part) and keeps it only when it goes through. */
  async add(d: Design, part: number, params: StepParams, label?: string, opts?: { sketch?: string; expectedRevision?: string }): Promise<Step> {
    return (await this.addStep(d, part, params, label, opts, false)).step
  }

  async addWithReceipt(d: Design, part: number, params: StepParams, label?: string, opts?: { sketch?: string; expectedRevision?: string }) {
    return this.addStep(d, part, params, label, opts, true)
  }

  private async addStep(d: Design, part: number, params: StepParams, label: string | undefined, opts: { sketch?: string; expectedRevision?: string } | undefined, receipt: boolean) {
    const guard = () => { if (opts?.expectedRevision !== undefined) this.revisions.assert(d.id, opts.expectedRevision) }
    guard()
    const step: Step = { id: stepId(), part, transform: [...d.transform], params, ...(label ? { label } : {}), ...(opts?.sketch ? { sketch: opts.sketch } : {}) }
    const history = appendStep(d.history, step)
    const r = await this.run(history)
    const st = r.status[r.status.length - 1]
    if (st?.state !== 'done') throw new ToolInputError(`The step did not go through: ${st?.message ?? 'the steps before it are broken'}. The design is unchanged.`, 'invalid_input', { design: d.id })
    guard()
    this.keep(d, history, r)
    d.redo = []
    const committed = receipt ? structuredClone(d) : d
    return { step: committed.history.steps[committed.history.steps.length - 1]!, revision: this.revision(d.id), design: committed }
  }

  /** Replays the design as it is, after an edit of its steps. */
  async replay(d: Design, opts?: { expectedRevision?: string }): Promise<void> {
    const guard = () => { if (opts?.expectedRevision !== undefined) this.revisions.assert(d.id, opts.expectedRevision) }
    guard()
    const r = await this.run(d.history)
    guard()
    this.keep(d, d.history, r)
  }

  private async run(history: History): Promise<Awaited<ReturnType<typeof replayHistory>>> {
    if (history.exact && process.env['SX_BREP_DEV'] !== '1') throw new ToolInputError('Exact designs require the developer opt-in SX_BREP_DEV=1.')
    const r = await replayHistory(this.deps.engine, { history, exact: history.exact === true })
    if (history.exact) {
      const broken = r.status.find(s => s.state === 'broken' || s.state === 'skipped')
      if (broken || r.exactFellBack?.length) throw new ToolInputError(`Exact replay stopped: ${broken?.message ?? 'a step requires the mesh path'}. The design is unchanged.`)
    }
    return r
  }

  private keep(d: Design, history: History, r: Awaited<ReturnType<typeof replayHistory>>): void {
    // A step that broke keeps its sentence, as the app shows it.
    const next: Design = { ...d,
      history: { ...history, steps: history.steps.map((s, i) => withBroken(s, r.status[i])) },
      parts: r.parts, status: r.status, madeBy: r.madeBy ?? {},
    }
    this.export(next)
    Object.assign(d, next)
    if (!next.stl) delete d.stl
    this.revisions.register(d.id)
  }

  /** Writes the parts as one STL in the object's frame, so slicing and the mesh tools can take the result. */
  private export(d: Design): void {
    if (!d.parts.length) {
      delete d.stl
      return
    }
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

/**
 * A design as a 3MF project, written by the app's own writer (@slicerx/threemf): one object on plate 1 whose parts are
 * components with their filament slots and paint (Orca and Bambu Studio's model_settings.config), and the CAD history
 * beside it as the design timeline the app saves (Metadata/slicerx_history.json), so it opens in the app as the
 * app's own files do. A design carries no print settings, so the file has none: a slicer opens it as a model and
 * places it on its bed.
 */
export function design3mf(d: Design): Buffer {
  if (!d.parts.length) throw new ToolInputError('The design has no parts yet; add a step that makes a body first.')
  const paint = Object.fromEntries(d.parts.flatMap((p, i) => (p.paint ? [[i, p.paint] as const] : [])))
  const files = projectFiles({
    plates: [{ name: '', objects: [{ id: d.id, name: d.name, parts: d.parts, paint, transform: d.transform, history: d.history }], settings: {} }],
    bed: { widthMm: 0, depthMm: 0 },
    application: productName(),
  })
  return writeZip(entryData(files))
}

/** A part as the engine's 3MF reader (sx-geom `format.read3mf`) gives it, its mesh as numbers. */
interface EnginePart {
  name?: string
  meshName?: string
  kind?: string
  kindText?: string | null
  slot?: number | null
  positions?: number[]
  indices?: number[]
  /** Painted triangles per layer as [triangle, code] pairs, or null with no paint. */
  paint?: Partial<Record<PaintLayer, [number, string][]>> | null
}

interface EngineObject {
  id: number
  name?: string
  /** The build item's transform as 3MF writes it (rows of a 4x3 matrix), in the file's unit. */
  transform?: number[]
  slot?: number | null
  parts?: EnginePart[]
}

type PaintLayer = keyof PaintTexts

/** What each kind of part that is not printed is called in Bambu Studio and Orca. */
const KIND_WORDS: Record<string, string> = { negative: 'negative part', modifier: 'modifier part', support_blocker: 'support blocker', support_enforcer: 'support enforcer' }

/** A 3MF transform (rows of a 4x3 matrix, in the file's unit) as a column-major Mat4 in millimeters. */
function fileMatrix(t: number[] | undefined, unitScale: number): Mat4 {
  if (!t || t.length !== 12 || t.some((x) => !Number.isFinite(x))) return [...IDENTITY]
  const v = (i: number): number => t[i]!
  return [v(0), v(1), v(2), 0, v(3), v(4), v(5), 0, v(6), v(7), v(8), 0, v(9) * unitScale, v(10) * unitScale, v(11) * unitScale, 1]
}

function paintOf(p: EnginePart['paint']): PaintTexts | undefined {
  if (!p) return undefined
  const out: PaintTexts = {}
  for (const [layer, pairs] of Object.entries(p) as [PaintLayer, [number, string][] | undefined][]) {
    if (pairs?.length) out[layer] = Object.fromEntries(pairs)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * The objects of a 3MF as designs to open, read by the engine's 3MF reader: those with a SlicerX CAD history keep
 * it, the others start from their printed parts (in their object's space, slots and paint kept) with no steps yet.
 * Modifiers and other volumes are left out and named.
 */
export async function readDesigns(engine: EngineCall, buf: Buffer, label: string): Promise<{ name: string; transform: Mat4; history?: History; base: HistoryMesh[]; skipped: string[] }[]> {
  const zip = readZip(buf, label)
  if (zip.text('3D/3dmodel.model') === undefined) throw new ToolInputError(`${label} is not a 3MF project: it has no 3D/3dmodel.model`, 'unsupported_format')
  let read: { unitScale?: number; objects?: EngineObject[] }
  try {
    read = (await engine('format.read3mf', { data: { base64: buf.toString('base64') } })) as typeof read
  } catch (e) {
    throw new ToolInputError(`${label}: ${e instanceof Error ? e.message : String(e)}`, 'invalid_model')
  }
  const unitScale = read.unitScale ?? 1
  const objects = (read.objects ?? []).flatMap((o) => {
    const name = o.name || `Object ${o.id}`
    const parts: HistoryMesh[] = []
    const skipped: string[] = []
    for (const p of o.parts ?? []) {
      const partName = p.name || p.meshName || name
      if (p.kind && p.kind !== 'normal') {
        skipped.push(`${partName} (${KIND_WORDS[p.kind] ?? p.kind.replace(/_/g, ' ')})`)
        continue
      }
      const paint = paintOf(p.paint)
      parts.push({ name: partName, slot: p.slot ?? o.slot ?? 1, positions: p.positions ?? [], indices: p.indices ?? [], ...(paint ? { paint } : {}) })
    }
    return parts.length ? [{ id: String(o.id), name, transform: fileMatrix(o.transform, unitScale), parts, skipped }] : []
  })
  const files = new Map<string, Uint8Array>()
  for (const n of zip.names()) if (n.startsWith('Metadata/slicerx_history')) files.set(n, zip.read(n) ?? new Uint8Array())
  const histories = parseHistories(files, new Set(objects.map((o) => o.id)))
  return objects.map((o) => {
    const h = histories.get(o.id)
    return { name: o.name, transform: o.transform, ...(h ? { history: h } : {}), base: o.parts, skipped: o.skipped }
  })
}

/** The server's files for the design tools: models from paths, URLs and samples, 3MF files in the output folder. */
export function designFiles(policy: PathPolicy, engine: EngineCall): DesignFiles {
  return {
    async model(from, name) {
      return [stlMesh(readFileSync(await resolveModel(policy, from)), name)]
    },
    async open(path) {
      return readDesigns(engine, readFileSync(await resolveModel(policy, path)), path)
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
