// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Object tools on sx-geom: repair, simplify, hollow, cut, auto orient, subtract a shape, and text.
// Each replaces the selected object in one store update, so undo takes it back in one step.
// Tools that depend on where the object sits (cut height, orientation, a hole from the top) work
// on the object with its transform baked in, then stand the result back on the bed.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { fromGeom, geom, toGeom, type GeomMesh } from '../geom/client'
import { get, markStale, set, toast, type PlateEntry } from '../state/store'
import { selectedEntry } from './edit'
import { bake, invert } from './mesh-ops'
import { repairHeadline, showRepairReport, sumRepair, type RepairCounts, type RepairEntry } from './repair-report'
import { bounds, compose, dropToBed, identity, multiply, type Mat4, type Vec3 } from './transform'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }

let seq = 0
const newId = () => `obj_${Date.now().toString(36)}g${(++seq).toString(36)}`

function need(): PlateEntry {
  const e = selectedEntry()
  if (!e) throw new Error('Select an object first.')
  return e
}

/** Parts in bed coordinates. */
function worldParts(e: PlateEntry): MeshPart[] {
  return e.parts.map((p) => bake(p, e.transform))
}

/** Parts from bed coordinates back to an object: centered in X and Y, standing on the bed. */
function standUp(parts: MeshPart[]): { parts: MeshPart[]; transform: Mat4 } {
  const b = bounds(parts, identity())
  if (!b) return { parts, transform: identity() }
  const c: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0]
  const local = parts.map((p) => bake(p, compose({ position: [-c[0], -c[1], 0], rotation: [0, 0, 0], scale: [1, 1, 1] })))
  const t = compose({ position: c, rotation: [0, 0, 0], scale: [1, 1, 1] })
  return { parts: local, transform: dropToBed(local, t) }
}

type StepParams = import('../cad/history/model').StepParams

/**
 * Puts new parts on the object in one store update. With `step`, the edit is a step of the object's
 * CAD history (docs/cad-history.md): `start` tools begin one, the others add to one that exists.
 */
async function replace(host: Loader, e: PlateEntry, parts: MeshPart[], transform: Mat4 = e.transform, step?: { params: StepParams; start: boolean }): Promise<void> {
  const handle = await host.loadParts(e.name, parts)
  const { instanceOf: _was, history: had, ...rest } = e
  let history = had
  if (step && (had || step.start)) history = (await import('../cad/history/record')).withStep(e, -1, step.params)
  set({ plate: get().plate.map((p) => (p.id === e.id ? { ...rest, handle, parts, transform, ...(history ? { history } : {}) } : p)) })
  markStale()
}

const nonEmpty = (m: GeomMesh | undefined): m is GeomMesh => Boolean(m && m.indices.length >= 3)

export async function repairSelected(host: Loader): Promise<string> {
  // The faces this makes get the keys of the history step it records.
  void (await import('../cad/history/record')).reserveStepId()
  const e = need()
  const entries: RepairEntry[] = []
  const parts: MeshPart[] = []
  for (const p of e.parts) {
    const r = await geom().call<{ mesh: GeomMesh; report: RepairCounts }>('repair', { mesh: toGeom(p), options: {} })
    parts.push(fromGeom(r.mesh, p.name, p.slot))
    entries.push({ label: p.name || e.name, report: r.report })
  }
  await replace(host, e, parts, e.transform, { params: { op: 'repair' }, start: false })
  const total = sumRepair(entries.map((x) => x.report))
  const msg = repairHeadline(total)
  const open = (total.holesLeftOpen ?? 0) > 0
  toast(msg, open ? 'warn' : 'ok', { label: 'Details', run: () => showRepairReport({ title: `Repair report for ${e.name}`, entries }) })
  return msg
}

export async function simplifySelected(host: Loader, targetRatio: number): Promise<string> {
  // The faces this makes get the keys of the history step it records.
  void (await import('../cad/history/record')).reserveStepId()
  const e = need()
  let before = 0, after = 0
  const parts: MeshPart[] = []
  for (const p of e.parts) {
    const r = await geom().call<{ mesh: GeomMesh; report: { before: number; after: number } }>('simplify', { mesh: toGeom(p), options: { targetRatio } })
    parts.push(fromGeom(r.mesh, p.name, p.slot))
    before += r.report.before
    after += r.report.after
  }
  await replace(host, e, parts, e.transform, { params: { op: 'simplify', targetRatio }, start: false })
  const msg = `Simplified from ${before.toLocaleString('en-US')} to ${after.toLocaleString('en-US')} triangles.`
  toast(msg, 'ok')
  return msg
}

export async function hollowSelected(host: Loader, wallMm: number): Promise<string> {
  // The faces this makes get the keys of the history step it records.
  void (await import('../cad/history/record')).reserveStepId()
  const e = need()
  let saved = 0
  const parts: MeshPart[] = []
  for (const p of e.parts) {
    const r = await geom().call<{ mesh: GeomMesh; report: { materialSavedPercent: number } }>('hollow', { mesh: toGeom(p), options: { wallMm } })
    parts.push(fromGeom(r.mesh, p.name, p.slot))
    saved = Math.max(saved, r.report.materialSavedPercent)
  }
  await replace(host, e, parts, e.transform, { params: { op: 'hollow', wallMm }, start: true })
  const msg = `Hollowed with ${wallMm} mm walls, about ${Math.round(saved)} % less material. Add a drain hole for resin.`
  toast(msg, 'ok')
  return msg
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

/** Cuts the selected object with a plane. The pieces become objects standing on the bed. */
export async function cutSelected(host: Loader, spec: CutSpec): Promise<number> {
  const e = need()
  const below: MeshPart[] = []
  const above: MeshPart[] = []
  const extras: MeshPart[] = []
  for (const p of worldParts(e)) {
    const r = await geom().call<{ below?: GeomMesh; above?: GeomMesh; extras?: GeomMesh[] }>('cut', { mesh: toGeom(p), plane: spec.plane ?? { axis: spec.axis, at: spec.atMm }, options: spec.connector ? { connector: spec.connector } : {} })
    if (nonEmpty(r.below)) below.push(fromGeom(r.below, p.name, p.slot))
    if (nonEmpty(r.above)) above.push(fromGeom(r.above, p.name, p.slot))
    for (const x of r.extras ?? []) if (nonEmpty(x)) extras.push(fromGeom(x, 'Connector', p.slot))
  }
  const pieces: { name: string; parts: MeshPart[] }[] = []
  if (spec.keep !== 'above' && below.length) pieces.push({ name: `${e.name} lower`, parts: below })
  if (spec.keep !== 'below' && above.length) pieces.push({ name: `${e.name} upper`, parts: above })
  extras.forEach((x, i) => pieces.push({ name: `${e.name} connector ${i + 1}`, parts: [x] }))
  if (pieces.length === 0 || (below.length === 0 && spec.keep !== 'above') || (above.length === 0 && spec.keep !== 'below')) {
    toast('The plane does not cross the object. Pick a height inside it.', 'warn')
    return 0
  }
  const entries: PlateEntry[] = await Promise.all(
    pieces.map(async (piece) => {
      const up = standUp(piece.parts)
      const handle = await host.loadParts(piece.name, up.parts)
      return { id: newId(), name: piece.name, handle, parts: up.parts, colors: [...e.colors], transform: up.transform }
    }),
  )
  const plate = get().plate
  const at = plate.findIndex((p) => p.id === e.id)
  set({ plate: [...plate.slice(0, at), ...entries, ...plate.slice(at + 1)], selection: entries[0]?.id ?? null, selectedIds: entries.map((x) => x.id) })
  markStale()
  return entries.length
}

/** The outline the plane leaves on an object, as closed loops in bed coordinates: the section view of the cut tool. */
export async function sectionLoops(e: PlateEntry, plane: { point: Vec3; normal: Vec3 }, signal?: AbortSignal): Promise<Vec3[][]> {
  type V2 = [number, number]
  const loops: Vec3[][] = []
  for (const p of worldParts(e)) {
    const r = await geom().call<{ frame: { origin: Vec3; u: Vec3; v: Vec3 }; polygons: { outer: V2[]; holes: V2[][] }[] }>('section', { mesh: toGeom(p), plane }, signal)
    const { origin: o, u, v } = r.frame
    const at = ([x, y]: V2): Vec3 => [o[0] + u[0] * x + v[0] * y, o[1] + u[1] * x + v[1] * y, o[2] + u[2] * x + v[2] * y]
    for (const poly of r.polygons) for (const l of [poly.outer, ...poly.holes]) if (l.length > 1) loops.push(l.map(at))
  }
  return loops
}

/** Auto orient: the orientation sx-geom ranks best (least support, most bed contact). */
export async function orientSelected(): Promise<string> {
  const e = need()
  const world = worldParts(e)
  const all: GeomMesh = { positions: [], indices: [] }
  for (const p of world) {
    const off = all.positions.length / 3
    all.positions.push(...p.positions)
    for (const i of p.indices) all.indices.push(i + off)
  }
  const r = await geom().call<{ ranked: { matrix: number[][]; supportVolumeMm3: number; heightMm: number }[] }>('orient.rank', { mesh: all, options: {}, maxCandidates: 12 })
  const best = r.ranked[0]
  if (!best) throw new Error('No orientation found.')
  const m = best.matrix
  const rot = identity()
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) rot[col * 4 + row] = m[row]?.[col] ?? (row === col ? 1 : 0)
  const b = bounds(e.parts, e.transform)
  const c: Vec3 = b ? [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] : [0, 0, 0]
  const to = compose({ position: [-c[0], -c[1], -c[2]], rotation: [0, 0, 0], scale: [1, 1, 1] })
  const back = compose({ position: c, rotation: [0, 0, 0], scale: [1, 1, 1] })
  const next = dropToBed(e.parts, multiply(back, multiply(rot, multiply(to, e.transform))))
  set({ plate: get().plate.map((p) => (p.id === e.id ? { ...p, transform: next } : p)) })
  markStale()
  const msg = `Oriented for ${Math.round(best.supportVolumeMm3 / 1000)} cm3 of support, ${best.heightMm.toFixed(1)} mm tall.`
  toast(msg, 'ok')
  return msg
}

export interface HoleSpec {
  shape: 'box' | 'cylinder'
  /** Width or diameter, mm. */
  sizeMm: number
  depthMm: number
  /** Offset of the hole from the top center of the object, mm, in X and Y. */
  offset: [number, number]
}

/** Boolean subtract: cuts a box or cylinder into the selected object from the top. */
export async function subtractFromSelected(host: Loader, spec: HoleSpec): Promise<string> {
  // The faces this makes get the keys of the history step it records.
  void (await import('../cad/history/record')).reserveStepId()
  const e = need()
  const world = worldParts(e)
  const b = bounds(world, identity())
  if (!b) throw new Error('The object has no geometry.')
  const cx = (b.min[0] + b.max[0]) / 2 + spec.offset[0]
  const cy = (b.min[1] + b.max[1]) / 2 + spec.offset[1]
  const top = b.max[2] + 0.5
  const h = spec.depthMm + 0.5
  const solid: import('../cad/history/model').SolidSpec =
    spec.shape === 'cylinder'
      ? { type: 'cylinder', origin: [cx, cy, top - h], axis: [0, 0, 1], diameterMm: spec.sizeMm, heightMm: h }
      : { type: 'box', min: [cx - spec.sizeMm / 2, cy - spec.sizeMm / 2, top - h], max: [cx + spec.sizeMm / 2, cy + spec.sizeMm / 2, top] }
  let removed = 0
  const parts: MeshPart[] = []
  for (const p of world) {
    const r = await geom().call<{ mesh: GeomMesh; removedVolumeMm3: number }>('subtract', { mesh: toGeom(p), solids: [solid] })
    parts.push(fromGeom(r.mesh, p.name, p.slot))
    removed += r.removedVolumeMm3
  }
  if (removed <= 0) {
    toast('The shape does not reach the object. Move it or make it deeper.', 'warn')
    return 'Nothing removed.'
  }
  // Back in the object's own frame, so the history's other steps keep their place; only the drop to the bed moves it.
  const back = invert(e.transform)
  const local = parts.map((p) => bake(p, back))
  const label = spec.shape === 'cylinder' ? `Hole ${spec.sizeMm} mm` : `Box cut ${spec.depthMm} mm`
  await replace(host, e, local, dropToBed(local, e.transform), { params: { op: 'subtract', solids: [solid], label }, start: true })
  const msg = `Removed ${(removed / 1000).toFixed(2)} cm3.`
  toast(msg, 'ok')
  return msg
}

export interface TextSpec {
  text: string
  sizeMm: number
  depthMm: number
  mode: 'emboss' | 'deboss'
}

/** Raises or sinks text on the object's top surface, centered, reading from the front. */
export async function textOnSelected(host: Loader, spec: TextSpec): Promise<string> {
  const e = need()
  const world = worldParts(e)
  // The part that reaches highest carries the text.
  let best = 0
  let bestTop = -Infinity
  world.forEach((p, i) => {
    const b = bounds([p], identity())
    if (b && b.max[2] > bestTop) {
      bestTop = b.max[2]
      best = i
    }
  })
  const target = world[best]
  const b = target ? bounds([target], identity()) : null
  if (!target || !b) throw new Error('The object has no geometry.')
  const point: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]
  const r = await geom().call<{ mesh: GeomMesh }>('emboss', { mesh: toGeom(target), spec: { text: spec.text, point, normal: [0, 0, 1], up: [0, 1, 0], sizeMm: spec.sizeMm, depthMm: spec.depthMm, mode: spec.mode } })
  const parts = world.map((p, i) => (i === best ? fromGeom(r.mesh, p.name, p.slot) : p))
  const up = standUp(parts)
  await replace(host, e, up.parts, up.transform)
  const msg = `${spec.mode === 'emboss' ? 'Raised' : 'Sank'} "${spec.text}" ${spec.depthMm} mm on the top.`
  toast(msg, 'ok')
  return msg
}
