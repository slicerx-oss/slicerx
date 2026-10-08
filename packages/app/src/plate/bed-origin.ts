// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The plate counts from its front left corner; the printer counts from its own origin. A bed whose printable area
// starts elsewhere (Snapmaker U1 at 0.5, 1; a delta centered on 0, 0) is shifted by the area's front left corner
// where the plate meets the engine: object placements and the hand placed prime tower go out in machine
// coordinates, and the preview, the tower the engine reports and the no-print areas come back to the plate.
import type { PlateObject, PrimeTowerPlacement } from '@slicerx/contracts'

export type Origin = readonly [number, number]

function point(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2) {
    const x = Number(v[0])
    const y = Number(v[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*x\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i.exec(v)
    if (m) return [Number(m[1]), Number(m[2])]
  }
  return null
}

/** The front left corner of a printable area in machine coordinates: where the plate's 0, 0 sits on the machine. */
export function areaOrigin(area: unknown): Origin {
  const items = typeof area === 'string' ? area.split(',') : Array.isArray(area) ? (area as unknown[]) : []
  const pts = items.map(point).filter((p): p is [number, number] => p !== null)
  if (pts.length < 3) return [0, 0]
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))]
}

/** The width and depth of a printable area, or null when it names no area. */
export function areaSize(area: unknown): { widthMm: number; depthMm: number } | null {
  const items = typeof area === 'string' ? area.split(',') : Array.isArray(area) ? (area as unknown[]) : []
  const pts = items.map(point).filter((p): p is [number, number] => p !== null)
  if (pts.length < 3) return null
  const widthMm = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))
  const depthMm = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))
  return widthMm > 0 && depthMm > 0 ? { widthMm, depthMm } : null
}

export function isZero(o: Origin): boolean {
  return o[0] === 0 && o[1] === 0
}

function shifted(t: readonly number[], origin: Origin): number[] {
  const out = [...t]
  out[12] = (out[12] ?? 0) + origin[0]
  out[13] = (out[13] ?? 0) + origin[1]
  return out
}

/** An object's placement on the machine, its volumes with it. */
export function objectToMachine(o: PlateObject, origin: Origin): PlateObject {
  if (isZero(origin)) return o
  return { ...o, transform: shifted(o.transform, origin), ...(o.volumes ? { volumes: o.volumes.map((v) => (v.transform ? { ...v, transform: shifted(v.transform, origin) } : v)) } : {}) }
}

/** The tower the engine reports, back on the plate. */
export function towerToPlate(t: PrimeTowerPlacement, origin: Origin): PrimeTowerPlacement {
  return isZero(origin) ? t : { ...t, x: t.x - origin[0], y: t.y - origin[1] }
}

/** Machine polygons (no-print areas) on the plate. */
export function polygonsToPlate<P extends readonly (readonly [number, number])[]>(polys: readonly P[], origin: Origin): [number, number][][] {
  return polys.map((p) => p.map(([x, y]) => [x - origin[0], y - origin[1]] as [number, number]))
}
