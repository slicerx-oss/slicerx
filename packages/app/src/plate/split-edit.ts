// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import type { DimensionAnchor, Feature } from '../geom/cad'
import { objectPalette } from '../edition'
import { get, markStale, set, type PaintData, type PlateEntry } from '../state/store'
import { remapPaint, splitPieces, splitToObjects } from './mesh-ops'
import { objectOverrides, partOverridesOf } from './object-settings'
import { bounds, identity, multiply, type Vec3 } from './transform'

type Loader = { loadParts(name: string, parts: MeshPart[]): Promise<MeshHandle> }
type Target = { id: string; triangle: number; offset: Vec3 }
let seq = 0
const nextId = () => `obj_split_${Date.now().toString(36)}_${++seq}`
const shifted = (p: Vec3, d: Vec3): Vec3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]
export class SplitError extends Error {
  constructor(readonly code: 'not_found' | 'refused' | 'busy', message: string) { super(message) }
}
const fail = (code: SplitError['code'], message: string): never => { throw new SplitError(code, message) }

function remapAnchor(a: DimensionAnchor, source: string, targets: Map<number, Target>): DimensionAnchor {
  if (a.object !== source) return a
  const t = targets.get(a.pick.triangle)
  if (!t) return fail('refused', 'A kept measurement refers to a missing triangle. Remove or repair it before splitting.')
  const f = a.feature
  const triangles = 'triangles' in f && f.triangles ? f.triangles.flatMap((i) => {
    const m = targets.get(i)
    return m?.id === t.id ? [m.triangle] : []
  }) : undefined
  let feature: Feature
  switch (f.kind) {
    case 'point': feature = { ...f, at: shifted(f.at, t.offset) }; break
    case 'edge': feature = { ...f, a: shifted(f.a, t.offset), b: shifted(f.b, t.offset) }; break
    case 'circle': feature = { ...f, center: shifted(f.center, t.offset) }; break
    case 'plane': case 'cylinder': feature = { ...f, point: shifted(f.point, t.offset), ...(triangles ? { triangles } : {}) }; break
    case 'surface': feature = { ...f, at: shifted(f.at, t.offset), ...(triangles ? { triangles } : {}) }; break
  }
  return { ...a, object: t.id, pick: { triangle: t.triangle, at: shifted(a.pick.at, t.offset) }, feature }
}

/** Split one concrete object, preserving print data and committing all changes as one undo step. */
export async function splitObject(host: Loader, id: string, mode: 'parts' | 'objects'): Promise<{ ids: string[]; parts: number }> {
  const initial = get()
  const src = initial.plate.find((e) => e.id === id)
  if (!src) return fail('not_found', 'The object is no longer on the shown plate.')
  if (src.locked) return fail('refused', `${src.name} is locked; unlock it first.`)
  const originalRoot = src.instanceOf ? [...initial.plate, ...initial.plates.flatMap((p) => p.objects)].find((e) => e.id === src.instanceOf) : undefined
  const { replaying } = await import('../cad/history/ops')
  const check = () => {
    const now = get()
    if (now.rollback || now.historyEdit?.objectId === id || replaying(id)) fail('busy', 'Finish editing the object and return to the end of the timeline before splitting.')
    if (now.activePlate !== initial.activePlate || now.plates !== initial.plates || now.objectSettings !== initial.objectSettings || now.plate.find((e) => e.id === id) !== src) fail('busy', 'The object or its plate changed while splitting; read it and try again.')
    if (originalRoot && [...now.plate, ...now.plates.flatMap((p) => p.objects)].find((e) => e.id === originalRoot.id) !== originalRoot) fail('busy', 'The source of this copy changed while splitting; read it and try again.')
  }
  check()
  const pieces = splitPieces(src.parts)
  if (pieces.length <= (mode === 'parts' ? src.parts.length : 1)) return fail('refused', 'This object is one piece; there is nothing to split.')
  const separate = mode === 'objects' ? splitToObjects(src.parts, src.transform) : undefined
  const specs = separate
    ? separate.map((p, i) => ({ ...p, id: nextId(), name: `${src.name} ${i + 1}`, sources: [p.from], mappings: [p.triangles] }))
    : [{ id, name: src.name, parts: pieces.map((p) => p.part), transform: src.transform, offset: [0, 0, 0] as Vec3, sources: pieces.map((p) => p.from), mappings: pieces.map((p) => p.triangles) }]
  const partSettings = partOverridesOf([...initial.plate, ...initial.plates.filter((p) => p.id !== initial.activePlate).flatMap((p) => p.objects)], src)
  const overrides = objectOverrides(initial, src)
  const wanted = new Set<number>()
  for (const e of [...initial.plate, ...initial.plates.filter((p) => p.id !== initial.activePlate).flatMap((p) => p.objects)]) {
    for (const d of e.dimensions ?? []) for (const a of [d.a, d.b]) {
      if (!a || a.object !== id) continue
      wanted.add(a.pick.triangle)
      if ('triangles' in a.feature) for (const t of a.feature.triangles ?? []) wanted.add(t)
    }
  }
  const targets = new Map<number, Target>()
  const starts: number[] = []
  let count = 0
  for (const part of src.parts) { starts.push(count); count += part.indices.length / 3 }
  const earOwner = src.brimPoints?.map((point) => {
    let best = 0
    let distance = Infinity
    specs.forEach((spec, i) => {
      const b = bounds(spec.parts, identity())
      if (!b) return
      const p = shifted([point[0], point[1], point[2]], spec.offset)
      const d = p.reduce((n, v, k) => n + Math.max(b.min[k]! - v, 0, v - b.max[k]!) ** 2, 0)
      if (d < distance) { best = i; distance = d }
    })
    return best
  })
  const { instanceOf: _instance, thumb: _thumb, paint: _paint, slotOverrides: _slots, partSettings: _partSettings, history: _history, dimensions: _dimensions, brimPoints: _ears, ...plain } = src
  const entries: PlateEntry[] = await Promise.all(specs.map(async (spec, index) => {
    const handle = await host.loadParts(spec.name, spec.parts)
    const paint: PaintData = {}
    const slots: Record<string, number> = {}
    const settings: NonNullable<PlateEntry['partSettings']> = {}
    let first = 0
    spec.parts.forEach((part, i) => {
      const from = spec.sources[i]!
      const old = src.parts[from]!
      const mapped = spec.mappings[i]!
      if (wanted.size) mapped.forEach((t, k) => {
        const old = starts[from]! + t
        if (wanted.has(old)) targets.set(old, { id: spec.id, triangle: first + k, offset: spec.offset })
      })
      first += mapped.length
      const layer = remapPaint(src.paint?.[from], mapped)
      if (layer) paint[i] = layer
      if (src.slotOverrides?.[old.name] !== undefined) slots[part.name] = src.slotOverrides[old.name]!
      if (partSettings[old.name]) settings[part.name] = { ...partSettings[old.name] }
    })
    const local = identity()
    local[12] = spec.offset[0]; local[13] = spec.offset[1]; local[14] = spec.offset[2]
    const brimPoints = src.brimPoints?.flatMap((p, k) => earOwner?.[k] === index ? [[...shifted([p[0], p[1], p[2]], spec.offset), p[3]] as [number, number, number, number]] : [])
    return {
      ...plain, id: spec.id, name: spec.name, handle, parts: spec.parts, transform: spec.transform,
      colors: spec.sources.map((from) => src.colors[from] ?? src.colors[0] ?? objectPalette()[((src.parts[from]?.slot ?? 1) - 1) % 6]!),
      ...(Object.keys(paint).length ? { paint } : {}), ...(Object.keys(slots).length ? { slotOverrides: slots } : {}), ...(Object.keys(settings).length ? { partSettings: settings } : {}),
      ...(src.volumes ? { volumes: src.volumes.map((v) => ({ ...v, id: mode === 'parts' ? v.id : `${spec.id}:${v.id}`, local: multiply(local, v.local) })) } : {}),
      ...(brimPoints?.length ? { brimPoints } : {}),
      ...(index === 0 && src.dimensions ? { dimensions: src.dimensions } : {}),
      ...(src.history ? { history: { version: src.history.version, base: spec.parts, steps: [], ended: `History ends here: the object was split into ${mode}.` } } : {}),
    }
  }))
  check()
  const now = get()
  const all = [...now.plate, ...now.plates.filter((p) => p.id !== now.activePlate).flatMap((p) => p.objects)]
  const copies = src.instanceOf ? [] : all.filter((e) => e.instanceOf === src.id)
  const root = copies[0]?.id
  const objectSettings = { ...now.objectSettings }
  if (mode === 'objects') delete objectSettings[id]
  for (const entry of entries) objectSettings[entry.id] = { ...overrides }
  if (root) objectSettings[root] = { ...overrides }
  const remap = (e: PlateEntry): PlateEntry => {
    let next = e
    if (root && e.instanceOf === src.id) {
      const { instanceOf: _old, ...rest } = e
      next = e.id === root ? { ...rest, partSettings: { ...partSettings } } : { ...rest, instanceOf: root }
    }
    if (next.dimensions) {
      const dimensions = next.dimensions.map((d) => {
        const a = remapAnchor(d.a, id, targets)
        const b = d.b ? remapAnchor(d.b, id, targets) : undefined
        return a === d.a && b === d.b ? d : { ...d, a, ...(b ? { b } : {}) }
      })
      if (dimensions.some((d, i) => d !== next.dimensions![i])) next = { ...next, dimensions }
    }
    return next
  }
  const plate = now.plate.flatMap((e) => e.id === id ? entries : [e]).map(remap)
  const plates = now.plates.map((p) => p.id === now.activePlate ? p : { ...p, objects: p.objects.map(remap) })
  const ids = entries.map((e) => e.id)
  set({ plate, plates, objectSettings, ...(mode === 'objects' ? { selection: ids[0] ?? null, selectedIds: ids } : {}) })
  markStale()
  return { ids, parts: pieces.length }
}
