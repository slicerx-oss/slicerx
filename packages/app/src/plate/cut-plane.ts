// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The cut tool's plane, shared by its panel and the 3D view. The panel shows it as two tilts and a
// distance from the object's center; the view moves and tilts it with its gizmo and reports the
// plane on release. Both write here, and each reads from here, so the two stay in step. The plane
// is kept through the point of it nearest the object's center.
import { createStore, useStore } from 'zustand'
import type { Vec3 } from './transform'
import type { get } from '../state/store'
import { clearanceFor } from './clearance'

export interface CutPlane {
  objectId: string
  /** A point of the plane in bed coordinates (mm): the one nearest the object's center. */
  point: Vec3
  /** Unit normal; "above" is the side it points to. */
  normal: Vec3
}

export type CutKeep = 'both' | 'above' | 'below'

export type ConnectorKind = 'none' | 'pin' | 'dowel' | 'dovetail'

/** Connectors for the cut, sizes in mm (OrcaSlicer's cut tool: size, depth and tolerance). */
export interface CutConnectors {
  kind: ConnectorKind
  diameterMm: number
  depthMm: number
  toleranceMm: number
  /** The tolerance was typed; until then it is the fit clearance (`connectorTolerance`). */
  toleranceSet?: boolean
  /** Where pins and dowels go, on the plane in bed coordinates (mm); empty places them automatically. */
  points: Vec3[]
  /** A click on the plane in the view adds a connector there, or takes away the one it lands on. */
  placing: boolean
}

export const NO_CONNECTORS: CutConnectors = { kind: 'none', diameterMm: 5, depthMm: 6, toleranceMm: 0.2, points: [], placing: false }

/** The connectors' tolerance: as typed, or the fit clearance from the hole test (half the nozzle without one). */
export function connectorTolerance(c: Pick<CutConnectors, 'toleranceMm' | 'toleranceSet'>, s: ReturnType<typeof get>): number {
  return c.toleranceSet ? c.toleranceMm : clearanceFor(s).mm
}

export const cutStore = createStore<{ plane: CutPlane | null; keep: CutKeep; connectors: CutConnectors }>()(() => ({ plane: null, keep: 'both', connectors: NO_CONNECTORS }))

export function useCutConnectors(): CutConnectors {
  return useStore(cutStore, (s) => s.connectors)
}

/** The point of the plane nearest `p`. */
export function onPlane(plane: Pick<CutPlane, 'point' | 'normal'>, p: Vec3): Vec3 {
  const d = dot([p[0] - plane.point[0], p[1] - plane.point[1], p[2] - plane.point[2]], plane.normal)
  return [p[0] - plane.normal[0] * d, p[1] - plane.normal[1] * d, p[2] - plane.normal[2] * d]
}

/** A click on the plane: takes away the connector it lands on, or adds one there. */
export function toggleConnector(at: Vec3): void {
  const { plane, connectors: c } = cutStore.getState()
  if (!plane || c.kind === 'none' || c.kind === 'dovetail') return
  const p = onPlane(plane, at)
  const hit = c.points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= c.diameterMm / 2)
  cutStore.setState({ connectors: { ...c, points: hit >= 0 ? c.points.filter((_, i) => i !== hit) : [...c.points, p] } })
}

/** Each connector as a circle of its diameter on the plane, for the view's guides. */
export function connectorRings(plane: Pick<CutPlane, 'normal'>, c: Pick<CutConnectors, 'points' | 'diameterMm'>, steps = 24): Vec3[][] {
  const n = plane.normal
  const u = unitVec(Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [0, -n[2], n[1]])
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  const r = c.diameterMm / 2
  return c.points.map((p) =>
    Array.from({ length: steps }, (_, i) => {
      const a = (i / steps) * 2 * Math.PI
      const [cs, sn] = [Math.cos(a) * r, Math.sin(a) * r]
      return [p[0] + u[0] * cs + v[0] * sn, p[1] + u[1] * cs + v[1] * sn, p[2] + u[2] * cs + v[2] * sn] as Vec3
    }),
  )
}

// Placed connectors stay on the plane as it moves or tilts, and go with another object.
cutStore.subscribe((s, prev) => {
  if (s.plane === prev.plane || s.connectors.points.length === 0) return
  if (!s.plane || s.plane.objectId !== prev.plane?.objectId) return cutStore.setState({ connectors: { ...s.connectors, points: [], placing: false } })
  const plane = s.plane
  cutStore.setState({ connectors: { ...s.connectors, points: s.connectors.points.map((p) => onPlane(plane, p)) } })
})

export function useCutPlane(): CutPlane | null {
  return useStore(cutStore, (s) => s.plane)
}

export function useCutKeep(): CutKeep {
  return useStore(cutStore, (s) => s.keep)
}

const DEG = Math.PI / 180
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export function unitVec(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1]
}

/**
 * The normal for a tilt about X, then about Y, from straight up (degrees): Ry(y) Rx(x) (0, 0, 1).
 * Horizontal is (0, 0), a plane square to X is (0, 90) and one square to Y is (-90, 0).
 */
export function normalOf(tiltX: number, tiltY: number): Vec3 {
  const a = tiltX * DEG
  const b = tiltY * DEG
  return [Math.cos(a) * Math.sin(b), -Math.sin(a), Math.cos(a) * Math.cos(b)]
}

/** The tilts of a normal, the inverse of `normalOf` (tilt about X within plus and minus 90 degrees). */
export function tiltsOf(n: Vec3): [number, number] {
  const u = unitVec(n)
  const x = Math.asin(Math.max(-1, Math.min(1, -u[1]))) / DEG
  const y = Math.abs(u[0]) < 1e-12 && Math.abs(u[2]) < 1e-12 ? 0 : Math.atan2(u[0], u[2]) / DEG
  return [clean(x), clean(y)]
}

const clean = (v: number): number => {
  const r = Math.round(v * 1e6) / 1e6
  return Object.is(r, -0) ? 0 : r
}

/** Signed distance of the plane from the center along its normal, mm. */
export function offsetOf(plane: Pick<CutPlane, 'point' | 'normal'>, center: Vec3): number {
  return dot([plane.point[0] - center[0], plane.point[1] - center[1], plane.point[2] - center[2]], plane.normal)
}

/** The plane along `normal` at `offset` mm from the center, through its point nearest the center. */
export function planeAt(objectId: string, center: Vec3, normal: Vec3, offset: number): CutPlane {
  const n = unitVec(normal)
  return { objectId, normal: n, point: [center[0] + n[0] * offset, center[1] + n[1] * offset, center[2] + n[2] * offset] }
}

/** Any plane, moved to the point of it nearest the center. */
export function canonical(plane: CutPlane, center: Vec3): CutPlane {
  const n = unitVec(plane.normal)
  return planeAt(plane.objectId, center, n, offsetOf({ point: plane.point, normal: n }, center))
}

/** How far the plane can sit from the center along a normal and still cross the box (`min`, `max` in bed coordinates). */
export function offsetRange(box: { min: Vec3; max: Vec3 }, center: Vec3, normal: Vec3): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < 8; i++) {
    const c: Vec3 = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]
    const d = dot([c[0] - center[0], c[1] - center[1], c[2] - center[2]], normal)
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
  }
  return [lo, hi]
}
