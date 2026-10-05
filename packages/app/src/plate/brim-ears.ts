// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Painted brim ears, after OrcaSlicer's brim ears gizmo (src/slic3r/GUI/Gizmos/GLGizmoBrimEars.cpp). A click on the
// model puts an ear on the bed at the click's x and y (z = -0.0001, as Orca places it); a right click on an ear
// removes it. The head diameter runs from 5 to 20 mm and starts at 16 times the first layer line width. An ear that
// does not touch the first layer, directly or through other ears, is flagged (Orca's `is_error`), since it would
// print as an island. The points are kept in the object's own space, like Orca's, so they follow the object.
import { createStore, useStore } from 'zustand'
import { get, markStale, set, type PlateEntry } from '../state/store'
import { resolveConfig } from '../adapters/config'
import { autoEarPositions, AUTO_DEFAULTS, detectionMax, firstLayerLoops } from './brim-auto'
import { quietly } from './history'
import { apply, type Mat4 } from './transform'

export type BrimPoint = [number, number, number, number]
export interface WorldEar {
  x: number
  y: number
  z: number
  r: number
  /** Not connected to the first layer: it would print on its own. */
  error: boolean
}

export const HEAD_MIN = 5
export const HEAD_MAX = 20
const BED_Z = -0.0001
const MAX_EARS = 2000

/** The head diameter the next ear gets. Null until the person moves the slider; then the default follows the profile. */
const chosen = createStore<{ diameter: number | null }>()(() => ({ diameter: null }))

const clampDiameter = (d: number): number => Math.min(HEAD_MAX, Math.max(HEAD_MIN, Math.round(d * 10) / 10))

/** Orca's default: 16 times the first layer line width (the nozzle diameter when the width is 0). */
export function defaultHeadDiameter(): number {
  const cfg = resolveConfig(get().easy, get().overrides) as Record<string, unknown>
  const num = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : Number(v))
  const nozzle = get().profile?.nozzle ?? 0.4
  const w = num(cfg['initial_layer_line_width'])
  return clampDiameter((Number.isFinite(w) && w > 0 ? w : nozzle) * 16)
}

export function headDiameter(): number {
  return chosen.getState().diameter ?? defaultHeadDiameter()
}

export function useHeadDiameter(): number {
  const picked = useStore(chosen, (s) => s.diameter)
  return picked ?? defaultHeadDiameter()
}

/** Calls back when the head diameter changes (for the viewport's hover disc). */
export function onHeadDiameter(cb: () => void): () => void {
  return chosen.subscribe(cb)
}

export function setHeadDiameter(d: number): void {
  chosen.setState({ diameter: clampDiameter(d) })
}

/** The entries that share these ears: the object and its instances. */
function group(plate: readonly PlateEntry[], id: string): PlateEntry[] {
  const e = plate.find((p) => p.id === id)
  if (!e) return []
  const root = e.instanceOf ?? e.id
  return plate.filter((p) => p.id === root || p.instanceOf === root)
}

function invert(m: Mat4): Mat4 | null {
  const a = m as number[]
  // Rigid and scaled transforms only: the upper 3x3 block inverted by cofactors, then the offset.
  const [m00, m10, m20, , m01, m11, m21, , m02, m12, m22] = a as [number, number, number, number, number, number, number, number, number, number, number]
  const c00 = m11 * m22 - m12 * m21
  const c01 = m12 * m20 - m10 * m22
  const c02 = m10 * m21 - m11 * m20
  const det = m00 * c00 + m01 * c01 + m02 * c02
  if (Math.abs(det) < 1e-12) return null
  const i00 = c00 / det
  const i01 = (m02 * m21 - m01 * m22) / det
  const i02 = (m01 * m12 - m02 * m11) / det
  const i10 = c01 / det
  const i11 = (m00 * m22 - m02 * m20) / det
  const i12 = (m02 * m10 - m00 * m12) / det
  const i20 = c02 / det
  const i21 = (m01 * m20 - m00 * m21) / det
  const i22 = (m00 * m11 - m01 * m10) / det
  const tx = a[12]!
  const ty = a[13]!
  const tz = a[14]!
  return [i00, i10, i20, 0, i01, i11, i21, 0, i02, i12, i22, 0, -(i00 * tx + i01 * ty + i02 * tz), -(i10 * tx + i11 * ty + i12 * tz), -(i20 * tx + i21 * ty + i22 * tz), 1] as unknown as Mat4
}

function write(id: string, fn: (pts: BrimPoint[]) => BrimPoint[]): boolean {
  const { plate } = get()
  const ids = new Set(group(plate, id).map((p) => p.id))
  const base = plate.find((p) => p.id === id)
  if (!base) return false
  const next = fn([...(base.brimPoints ?? [])])
  set({
    plate: plate.map((p) => {
      if (!ids.has(p.id)) return p
      const { brimPoints: _old, ...rest } = p
      return (next.length ? { ...rest, brimPoints: next } : rest) as PlateEntry
    }),
  })
  markStale()
  return true
}

/** Adds an ear where the click hit the model, in bed coordinates. Returns false for a duplicate or a full list. */
export function addEar(objectId: string, bedX: number, bedY: number, diameter: number = headDiameter()): boolean {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e) return false
  const inv = invert(e.transform as Mat4)
  if (!inv) return false
  const [x, y, z] = apply(inv, [bedX, bedY, BED_Z])
  const r = clampDiameter(diameter) / 2
  const existing = e.brimPoints ?? []
  if (existing.length >= MAX_EARS || existing.some((q) => Math.hypot(q[0] - x, q[1] - y) < 1e-3)) return false
  return write(objectId, (pts) => [...pts, [x, y, z, r]])
}

export function removeEar(objectId: string, index: number): boolean {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e?.brimPoints?.[index]) return false
  picked.setState({ objectId, indices: [] })
  return write(objectId, (pts) => pts.filter((_, i) => i !== index))
}

export function clearEars(objectId: string): boolean {
  const e = get().plate.find((p) => p.id === objectId)
  if (!e?.brimPoints?.length) return false
  picked.setState({ objectId, indices: [] })
  return write(objectId, () => [])
}

/** The ears chosen for removal, resizing and moving (Orca's `selected`), by position in the object's list. */
const picked = createStore<{ objectId: string | null; indices: number[] }>()(() => ({ objectId: null, indices: [] }))

export function selectedEars(objectId: string): number[] {
  const s = picked.getState()
  return s.objectId === objectId ? s.indices : []
}

export function useSelectedEars(objectId: string | undefined): number[] {
  const s = useStore(picked, (x) => x)
  return objectId && s.objectId === objectId ? s.indices : EMPTY
}
const EMPTY: number[] = []

export function onEarSelection(cb: () => void): () => void {
  return picked.subscribe(cb)
}

/** Orca's select_point, with the three ways a gesture changes the selection. */
export function selectEars(objectId: string, indices: readonly number[], mode: 'set' | 'add' | 'remove' = 'set'): void {
  const count = get().plate.find((p) => p.id === objectId)?.brimPoints?.length ?? 0
  const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < count)
  const now = new Set(selectedEars(objectId))
  const next = mode === 'set' ? new Set(valid) : now
  if (mode === 'add') for (const i of valid) next.add(i)
  if (mode === 'remove') for (const i of valid) next.delete(i)
  picked.setState({ objectId, indices: [...next].sort((a, b) => a - b) })
  // Choosing ears shows their size on the slider, as Orca does.
  const first = valid[0] !== undefined ? get().plate.find((p) => p.id === objectId)?.brimPoints?.[valid[0]] : undefined
  if (mode !== 'remove' && first) setHeadDiameter(first[3] * 2)
}

export function selectAllEars(objectId: string): void {
  const count = get().plate.find((p) => p.id === objectId)?.brimPoints?.length ?? 0
  selectEars(objectId, Array.from({ length: count }, (_, i) => i))
}

/** Removes the selected ears (Orca's Delete key and Remove > Selected). */
export function removeSelectedEars(objectId: string): boolean {
  const sel = new Set(selectedEars(objectId))
  if (!sel.size) return false
  const done = write(objectId, (pts) => pts.filter((_, i) => !sel.has(i)))
  picked.setState({ objectId, indices: [] })
  return done
}

/** The selected ears take the diameter (Orca changes the selected points with the slider, and the next ear's size with them). */
export function resizeSelectedEars(objectId: string, diameter: number): boolean {
  const sel = new Set(selectedEars(objectId))
  const e = get().plate.find((p) => p.id === objectId)
  if (!sel.size || !e?.brimPoints?.length) return false
  const r = clampDiameter(diameter) / 2
  return write(objectId, (pts) => pts.map((q, i) => (sel.has(i) ? [q[0], q[1], q[2], r] : q)))
}

let dragStart: { objectId: string; index: number; point: BrimPoint } | null = null

/** Drags an ear along the model: x and y follow the hit, z stays (Orca's on_dragging). The whole drag is one undo step. */
export function moveEar(objectId: string, index: number, bedX: number, bedY: number, final: boolean): boolean {
  const e = get().plate.find((p) => p.id === objectId)
  const inv = e ? invert(e.transform as Mat4) : null
  const cur = e?.brimPoints?.[index]
  if (!e || !inv || !cur) return false
  if (!dragStart || dragStart.objectId !== objectId || dragStart.index !== index) dragStart = { objectId, index, point: [...cur] as BrimPoint }
  const [x, y] = apply(inv, [bedX, bedY, BED_Z])
  const moved = (pts: BrimPoint[]): BrimPoint[] => pts.map((q, i) => (i === index ? ([x, y, q[2], q[3]] as BrimPoint) : q))
  if (!final) return quietly(() => write(objectId, moved))
  const start = dragStart
  dragStart = null
  // Back to where the drag began without a step, then the move as the one step.
  quietly(() => write(objectId, (pts) => pts.map((q, i) => (i === index ? start.point : q))))
  if (Math.hypot(start.point[0] - x, start.point[1] - y) < 1e-3) return false
  return write(objectId, moved)
}

/** Orca's Auto-generate: ears at the first layer's convex corners and the concave corners of its holes. Returns how many were added. */
export function autoGenerateEars(objectId: string, opts: { maxAngle: number; detection: number; diameter?: number }): number {
  const e = get().plate.find((p) => p.id === objectId)
  const inv = e ? invert(e.transform as Mat4) : null
  if (!e || !inv) return 0
  const loops = firstLayerLoops(e)
  const spots = autoEarPositions(loops, opts.detection, opts.maxAngle)
  const r = clampDiameter(opts.diameter ?? headDiameter()) / 2
  const have = [...(e.brimPoints ?? [])]
  const added: BrimPoint[] = []
  for (const [bx, by] of spots) {
    const [x, y, z] = apply(inv, [bx, by, BED_Z])
    if (have.length + added.length >= MAX_EARS) break
    if ([...have, ...added].some((q) => Math.hypot(q[0] - x, q[1] - y) < 1e-3)) continue
    added.push([x, y, z, r])
  }
  if (!added.length) return 0
  write(objectId, (pts) => [...pts, ...added])
  return added.length
}

/** How far the detection length can go before it stops changing the outline, for the slider. */
export function detectionRange(objectId: string): number {
  const e = get().plate.find((p) => p.id === objectId)
  return e ? detectionMax(firstLayerLoops(e)) : 100
}

export { AUTO_DEFAULTS }

// First layer footprint: the triangles of the object's underside, in bed coordinates.
type Tri = [number, number, number, number, number, number]
const FOOT_MM = 0.3

function footprint(e: PlateEntry): Tri[] {
  const tris: Tri[] = []
  let low = Infinity
  const world: { p: Float32Array; ix: ArrayLike<number> | undefined }[] = []
  for (const part of e.parts) {
    const p = new Float32Array(part.positions.length)
    for (let i = 0; i + 2 < p.length; i += 3) {
      const [x, y, z] = apply(e.transform as Mat4, [part.positions[i]!, part.positions[i + 1]!, part.positions[i + 2]!])
      p[i] = x
      p[i + 1] = y
      p[i + 2] = z
      if (z < low) low = z
    }
    world.push({ p, ix: part.indices })
  }
  for (const { p, ix } of world) {
    if (!ix) continue
    for (let i = 0; i + 2 < ix.length; i += 3) {
      const a = ix[i]! * 3
      const b = ix[i + 1]! * 3
      const c = ix[i + 2]! * 3
      if (p[a + 2]! <= low + FOOT_MM && p[b + 2]! <= low + FOOT_MM && p[c + 2]! <= low + FOOT_MM) tris.push([p[a]!, p[a + 1]!, p[b]!, p[b + 1]!, p[c]!, p[c + 1]!])
    }
  }
  return tris
}

/** Distance from a point to a triangle in the plane; 0 inside. */
function distToTri(px: number, py: number, t: Tri): number {
  const [ax, ay, bx, by, cx, cy] = t
  const side = (x1: number, y1: number, x2: number, y2: number): number => (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)
  const d1 = side(ax, ay, bx, by)
  const d2 = side(bx, by, cx, cy)
  const d3 = side(cx, cy, ax, ay)
  if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return 0
  const seg = (x1: number, y1: number, x2: number, y2: number): number => {
    const dx = x2 - x1
    const dy = y2 - y1
    const l2 = dx * dx + dy * dy
    const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2))
    return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy))
  }
  return Math.min(seg(ax, ay, bx, by), seg(bx, by, cx, cy), seg(cx, cy, ax, ay))
}

const footCache = new WeakMap<PlateEntry, Tri[]>()

/** The ears of an object in bed coordinates, each flagged when it does not connect to the first layer. */
export function worldEars(e: PlateEntry): WorldEar[] {
  const pts = e.brimPoints
  if (!pts?.length) return []
  const ears = pts.map((q) => {
    const [x, y, z] = apply(e.transform as Mat4, [q[0], q[1], q[2]])
    return { x, y, z, r: q[3], error: true }
  })
  let tris = footCache.get(e)
  if (!tris) {
    tris = footprint(e)
    footCache.set(e, tris)
  }
  const live = new Set<number>()
  const queue: number[] = []
  ears.forEach((ear, i) => {
    if (tris!.some((t) => distToTri(ear.x, ear.y, t) <= ear.r)) {
      live.add(i)
      queue.push(i)
    }
  })
  while (queue.length) {
    const i = queue.pop()!
    const a = ears[i]!
    ears.forEach((b, j) => {
      if (!live.has(j) && Math.hypot(a.x - b.x, a.y - b.y) <= a.r + b.r) {
        live.add(j)
        queue.push(j)
      }
    })
  }
  return ears.map((ear, i) => ({ ...ear, error: !live.has(i) }))
}

/** True when the plate's resolved brim type is painted. */
export function brimIsPainted(): boolean {
  const cfg = resolveConfig(get().easy, get().overrides) as Record<string, unknown>
  return String(cfg['brim_type'] ?? '') === 'painted'
}
