// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { fromGeom, geom, toGeom, type GeomMesh } from '../geom/client'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { bake } from './mesh-ops'
import { apply, bounds, compose, dropToBed, identity, multiply, type Box, type Mat4, type Vec3 } from './transform'
import { modelPlace } from './edit'
import { objectOverrides, partOverridesOf } from './object-settings'
import { cutMetadata } from './cut-metadata'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }
let seq = 0
const newId = () => 'obj_cut_' + Date.now().toString(36) + '_' + (++seq).toString(36)
const nonEmpty = (m: GeomMesh | undefined): m is GeomMesh => Boolean(m && m.indices.length >= 3)
function worldParts(e: PlateEntry): MeshPart[] { return e.parts.map((p) => bake(p, e.transform)) }
function standUp(parts: MeshPart[]) {
  const box = bounds(parts, identity())!
  const center: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, 0]
  const toLocal = compose({ position: center.map((v) => -v) as Vec3, rotation: [0,0,0], scale: [1,1,1] })
  const local = parts.map((p) => bake(p, toLocal))
  const transform = dropToBed(local, compose({ position: center, rotation: [0,0,0], scale: [1,1,1] }))
  return { parts: local, transform, toLocal, box }
}

export interface CutSpec {
  axis: 'x' | 'y' | 'z'
  /** Plane position in bed coordinates, mm. */
  atMm: number
  /** Any plane in bed coordinates (the cut tool's gizmo); used instead of `axis` and `atMm` when given. */
  plane?: { point: Vec3; normal: Vec3 }
  keep: 'both' | 'above' | 'below'
  /** Connectors; `positions` (bed coordinates, mm, on the plane) place pins and dowels, otherwise they go in automatically (`count` of them when given). */
  connector?: { kind: 'pin' | 'dowel' | 'dovetail'; diameterMm: number; depthMm: number; toleranceMm: number; count?: number; positions?: Vec3[] }
}

export interface CutReport {
  sectionAreaMm2: number
  seamLengthMm: number
  islands: number
  connectors: Vec3[]
  belowVolumeMm3: number
  aboveVolumeMm3: number
  belowEdges: { boundaryEdges: number; nonManifoldEdges: number; flippedEdges: number }
  aboveEdges: CutReport['belowEdges']
  warnings: string[]
}

export interface CutResult {
  changed: boolean
  removed?: string
  ids: string[]
  reports: { part: number; name: string; report: CutReport }[]
  warnings: string[]
}

export class CutError extends Error {
  constructor(readonly code: 'invalid_input' | 'not_found' | 'refused' | 'busy', message: string) { super(message) }
}

function validate(spec: CutSpec): void {
  const vector = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
  if (!['both', 'above', 'below'].includes(spec.keep)) throw new CutError('invalid_input', 'Keep must be both, above or below.')
  if (spec.plane ? !vector(spec.plane.point) || !vector(spec.plane.normal) || Math.hypot(...spec.plane.normal) < 1e-9 : !['x','y','z'].includes(spec.axis) || !Number.isFinite(spec.atMm)) throw new CutError('invalid_input', 'A cut needs a finite plane with a nonzero normal.')
  const c = spec.connector
  if (!c) return
  if (!['pin','dowel','dovetail'].includes(c.kind) || !Number.isFinite(c.diameterMm) || c.diameterMm <= 0 || !Number.isFinite(c.depthMm) || c.depthMm <= 0 || !Number.isFinite(c.toleranceMm) || c.toleranceMm < 0) throw new CutError('invalid_input', 'Connector dimensions must be positive and tolerance must be nonnegative.')
  if (c.count !== undefined && (!Number.isInteger(c.count) || c.count < 1 || c.count > 16)) throw new CutError('invalid_input', 'Connector count must be an integer from 1 to 16.')
  if (c.positions && (c.positions.length > 16 || !c.positions.every(vector))) throw new CutError('invalid_input', 'Use at most 16 finite connector positions.')
  if (c.kind === 'dovetail' && c.positions?.length) throw new CutError('invalid_input', 'Dovetails use automatic placement.')
}

/** Cut one concrete object, even if the selection changes while geometry is running. */
export async function cutObject(host: Loader, id: string, spec: CutSpec): Promise<CutResult> {
  validate(spec)
  const initial = get()
  const e = initial.plate.find((entry) => entry.id === id)
  if (!e) throw new CutError('not_found', 'The object is no longer on the shown plate.')
  if (e.locked) throw new CutError('refused', `${e.name} is locked; unlock it first.`)
  const before = bounds(e.parts, e.transform)
  if (!before) throw new CutError('refused', 'The object has no geometry to cut.')
  const all = [...initial.plate, ...initial.plates.filter((p) => p.id !== initial.activePlate).flatMap((p) => p.objects)]
  const source = e.instanceOf ? all.find((entry) => entry.id === e.instanceOf) : undefined
  const settings = objectOverrides(initial, e)
  const partSettings = partOverridesOf(all, e)
  const { replaying } = await import('../cad/history/ops')
  const check = () => {
    const now = get()
    if (now.rollback || now.historyEdit?.objectId === id || replaying(id)) throw new CutError('busy', 'Finish editing the object and return to the end of the timeline before cutting.')
    if (now.activePlate !== initial.activePlate || now.plates !== initial.plates || now.objectSettings !== initial.objectSettings || now.plate !== initial.plate) throw new CutError('busy', 'The object or its plate changed while cutting; read it and try again.')
    if (source && [...now.plate, ...now.plates.flatMap((p) => p.objects)].find((entry) => entry.id === source.id) !== source) throw new CutError('busy', 'The source of this copy changed while cutting; read it and try again.')
  }
  check()
  const below: MeshPart[] = []
  const above: MeshPart[] = []
  const extras: MeshPart[] = []
  const sources = new Map<MeshPart, number>()
  const reports: CutResult['reports'] = []
  const plane = spec.plane ?? { point: ['x','y','z'].map((axis) => axis === spec.axis ? spec.atMm : 0) as Vec3, normal: ['x','y','z'].map((axis) => axis === spec.axis ? 1 : 0) as Vec3 }
  for (const [part, p] of worldParts(e).entries()) {
    const r = await geom().call<{ below?: GeomMesh; above?: GeomMesh; extras?: GeomMesh[]; report?: CutReport }>('cut', { mesh: toGeom(p), plane, options: spec.connector ? { connector: spec.connector } : {} })
    if (r.report) reports.push({ part, name: p.name, report: r.report })
    const add = (mesh: GeomMesh | undefined, into: MeshPart[], name = p.name) => {
      if (!nonEmpty(mesh)) return
      const made = fromGeom(mesh, name, e.slotOverrides?.[p.name] ?? p.slot)
      sources.set(made, part)
      into.push(made)
    }
    add(r.below, below)
    add(r.above, above)
    for (const x of r.extras ?? []) add(x, extras, 'Connector')
  }
  const warnings = reports.flatMap((r) => r.report.warnings)
  const pieces: { name: string; parts: MeshPart[]; side: 'below' | 'above' | 'connector' }[] = []
  if (spec.keep !== 'above' && below.length) pieces.push({ name: `${e.name} lower`, parts: below, side: 'below' })
  if (spec.keep !== 'below' && above.length) pieces.push({ name: `${e.name} upper`, parts: above, side: 'above' })
  extras.forEach((x, i) => pieces.push({ name: `${e.name} connector ${i + 1}`, parts: [x], side: 'connector' }))
  if (pieces.length === 0 || below.length === 0 || above.length === 0) {
    return { changed: false, ids: [id], reports, warnings: [...warnings, 'The plane does not cross the object. Pick a height inside it.'] }
  }
  if (e.paint && Object.keys(e.paint).length || e.parts.some((p) => p.paint && Object.keys(p.paint).length)) warnings.push('The cut cleared triangle paint because the triangles changed. Undo restores it.')
  const affected = (d: NonNullable<PlateEntry['dimensions']>[number]) => d.a.object === id || d.b?.object === id
  const measurements = all.flatMap((entry) => entry.dimensions ?? []).filter(affected).length
  if (measurements) warnings.push(`The cut cleared ${measurements} measurement${measurements === 1 ? '' : 's'} attached to the replaced geometry. Undo restores them.`)
  const ears = e.brimPoints ?? []
  const sideOf = (ear: [number, number, number, number]) => {
    const point = apply(e.transform, [ear[0], ear[1], ear[2]])
    return point.reduce((sum, value, i) => sum + (value - plane.point[i]!) * plane.normal[i]!, 0) <= 0 ? 'below' : 'above'
  }
  const entries: PlateEntry[] = await Promise.all(
    pieces.map(async (piece) => {
      const up = standUp(piece.parts)
      const handle = await host.loadParts(piece.name, up.parts)
      const pieceId = newId()
      const slots = Object.fromEntries(piece.parts.flatMap((p) => {
        const value = e.slotOverrides?.[e.parts[sources.get(p)!]!.name]
        return value === undefined ? [] : [[p.name, value]]
      }))
      const overrides = Object.fromEntries(piece.parts.flatMap((p) => {
        const value = partSettings[e.parts[sources.get(p)!]!.name]
        return value ? [[p.name, { ...value }]] : []
      }))
      return {
        id: pieceId, name: piece.name, handle, parts: up.parts, colors: piece.parts.map((p) => e.colors[sources.get(p)!] ?? e.colors[0]!), transform: up.transform,
        ...(piece.side !== 'connector' ? cutMetadata(e, pieceId, multiply(up.toLocal, e.transform), before, up.box, ears.filter((ear) => sideOf(ear) === piece.side)) : {}),
        ...(e.printable !== undefined ? { printable: e.printable } : {}),
        ...(Object.keys(slots).length ? { slotOverrides: slots } : {}),
        ...(Object.keys(overrides).length ? { partSettings: overrides } : {}),
        ...(e.source ? { source: e.source } : {}),
        ...(e.history ? { history: { version: e.history.version, base: up.parts, steps: [], ended: 'History ends here: the object was cut into separate objects.' } } : {}),
      }
    }),
  )
  check()
  const plate = get().plate
  // the pieces stand side by side, each beside the one before and clear of the other objects, not on top of each other
  const boxOf = (x: PlateEntry) => bounds(x.parts, x.transform)
  const taken = plate.filter((p) => p.id !== e.id).map(boxOf).filter((b): b is Box => b !== null)
  for (let i = 1; i < entries.length; i++) {
    const prev = boxOf(entries[i - 1]!)
    const own = boxOf(entries[i]!)
    if (!prev || !own) continue
    taken.push(prev)
    const size: Vec3 = [own.max[0] - own.min[0], own.max[1] - own.min[1], 0]
    const [x, y] = modelPlace(size, [0, 0, 0], prev, taken)
    const move = compose({ position: [x - (own.min[0] + own.max[0]) / 2, y - (own.min[1] + own.max[1]) / 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
    entries[i] = { ...entries[i]!, transform: multiply(move, entries[i]!.transform) }
  }
  const at = plate.findIndex((p) => p.id === e.id)
  const copies = e.instanceOf ? [] : all.filter((entry) => entry.instanceOf === e.id)
  const root = copies[0]?.id
  const objectSettings = { ...initial.objectSettings }
  delete objectSettings[e.id]
  for (const entry of entries) objectSettings[entry.id] = { ...settings }
  if (root) objectSettings[root] = { ...settings }
  const detach = (entry: PlateEntry): PlateEntry => {
    let next = entry
    if (root && entry.instanceOf === e.id) {
      const { instanceOf: _source, ...plain } = entry
      next = entry.id === root ? { ...plain, partSettings: { ...partSettings } } : { ...plain, instanceOf: root }
    }
    if (next.dimensions?.some(affected)) {
      const { dimensions, ...plain } = next
      const kept = dimensions.filter((d) => !affected(d))
      next = { ...plain, ...(kept.length ? { dimensions: kept } : {}) }
    }
    return next
  }
  const keptDimensions = e.dimensions?.filter((d) => !affected(d))
  if (entries[0] && keptDimensions?.length) entries[0] = { ...entries[0], dimensions: keptDimensions }
  const plates = initial.plates.map((p) => p.id === initial.activePlate ? p : { ...p, objects: p.objects.map(detach) })
  set({ plate: [...plate.slice(0, at), ...entries, ...plate.slice(at + 1)].map(detach), plates, objectSettings, selection: entries[0]?.id ?? null, selectedIds: entries.map((x) => x.id) })
  markStale()
  return { changed: true, removed: id, ids: entries.map((entry) => entry.id), reports, warnings }
}

