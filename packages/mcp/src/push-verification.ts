// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { HistoryMesh } from '@slicerx/cad-history'

/** Measures the retained face in world millimeters, never substituting a nearby face. */
export function verifyPush(part: HistoryMesh | undefined, transform: readonly number[], face: number | undefined, at: readonly number[], normal: readonly number[], distanceMm: number) {
  const toleranceMm = Number.isFinite(distanceMm) && distanceMm !== 0 ? Math.min(0.01, Math.abs(distanceMm) * 0.01) : 0.01
  const result = (status: 'verified' | 'failed' | 'unverified', measuredDistanceMm: number | null, reason?: string) => ({
    status, source: 'tessellation' as const, requestedDistanceMm: Number.isFinite(distanceMm) ? distanceMm : null, measuredDistanceMm, toleranceMm, ...(reason ? { reason } : {}),
  })
  if (!part || face === undefined) return result('unverified', null, 'A unique planar target face is unavailable after the edit.')
  if (transform.length !== 16 || at.length !== 3 || normal.length !== 3 || ![...transform, ...at, ...normal, distanceMm].every(Number.isFinite)
    || Math.abs(Math.hypot(...normal) - 1) > 1e-6 || part.indices.length % 3 || part.faces?.ids.length !== part.indices.length / 3) {
    return result('failed', null, 'The face measurement inputs are invalid.')
  }
  let min = Infinity, max = -Infinity, area = 0
  for (let triangle = 0; triangle < part.faces.ids.length; triangle++) {
    if (part.faces.ids[triangle] !== face) continue
    const points: number[][] = []
    for (let corner = 0; corner < 3; corner++) {
      const index = part.indices[triangle * 3 + corner]!
      if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= part.positions.length) return result('failed', null, 'The target face has an invalid vertex.')
      const p = [0, 1, 2].map(k => transform[k]! * part.positions[index * 3]! + transform[k + 4]! * part.positions[index * 3 + 1]! + transform[k + 8]! * part.positions[index * 3 + 2]! + transform[k + 12]!)
      const projection = p.reduce((sum, v, k) => sum + (v - at[k]!) * normal[k]!, 0)
      if (!p.every(Number.isFinite) || !Number.isFinite(projection)) return result('failed', null, 'The target face has a nonfinite measurement.')
      min = Math.min(min, projection); max = Math.max(max, projection)
      points.push(p)
    }
    const u = points[1]!.map((v, k) => v - points[0]![k]!), v = points[2]!.map((v, k) => v - points[0]![k]!)
    area += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(area) || area <= 1e-12) return result('unverified', null, 'The target face has no measurable surface.')
  if (max - min > toleranceMm) return result('failed', null, 'The target face is not parallel to the original plane.')
  const measured = min + (max - min) / 2
  return Math.abs(measured - distanceMm) <= toleranceMm
    ? result('verified', measured)
    : result('failed', measured, 'The measured displacement does not match the requested distance.')
}
