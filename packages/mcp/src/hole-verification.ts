// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
type Hole = { entry: number[]; axis: number[]; diameterMm: number; depthMm: number; through: boolean }
type Request = { diameter_mm?: number | undefined; depth_mm?: number | undefined; counterbore?: unknown; countersink?: unknown }

/** Verifies shaft measurements; head dimensions require a separate measurement. */
export function verifyHole(before: Hole, shaft: Hole, request: Request) {
  const diameterMm = request.diameter_mm ?? before.diameterMm
  const depthMm = before.through ? before.depthMm : request.depth_mm ?? before.depthMm
  const changes = [Math.abs(diameterMm - before.diameterMm), Math.abs(depthMm - before.depthMm)].filter(v => Number.isFinite(v) && v > 0)
  const toleranceMm = Math.min(0.01, ...changes.map(v => v * 0.01))
  const finite = [before.entry, before.axis, shaft.entry, shaft.axis].every(v => v.length === 3 && v.every(Number.isFinite))
    && [diameterMm, depthMm, shaft.diameterMm, shaft.depthMm].every(Number.isFinite)
  const dot = (a: number[], b: number[]) => a.reduce((sum, v, k) => sum + v * b[k]!, 0)
  const delta = shaft.entry.map((v, k) => before.entry[k]! - v)
  const startDepth = dot(delta, before.axis)
  const measuredDepthMm = Math.max(startDepth, startDepth + dot(shaft.axis, before.axis) * shaft.depthMm)
  const axisParallel = Math.abs(Math.abs(dot(before.axis, shaft.axis)) - 1) <= 1e-6
    && Math.abs(dot(before.axis, before.axis) - 1) <= 1e-6 && Math.abs(dot(shaft.axis, shaft.axis) - 1) <= 1e-6
  const axisDistanceMm = Math.hypot(...delta.map((v, k) => v - startDepth * before.axis[k]!))
  const checks = {
    finite,
    targetAxis: finite && axisParallel && axisDistanceMm <= toleranceMm,
    diameter: finite && Math.abs(shaft.diameterMm - diameterMm) <= toleranceMm,
    depth: finite && Math.abs(measuredDepthMm - depthMm) <= toleranceMm,
    kind: shaft.through === before.through,
  }
  const matched = Object.values(checks).every(Boolean)
  const head = !!(request.counterbore || request.countersink)
  return {
    status: !matched ? 'failed' as const : head ? 'unverified' as const : 'verified' as const,
    ...(!matched ? { reason: 'The measured shaft does not match the requested hole.' } : head ? { reason: 'The shaft matches, but head dimensions have not been measured.' } : {}),
    toleranceMm, checks, measuredDepthMm: Number.isFinite(measuredDepthMm) ? measuredDepthMm : null,
    requested: { diameterMm: Number.isFinite(diameterMm) ? diameterMm : null, depthMm: Number.isFinite(depthMm) ? depthMm : null,
      ...(request.counterbore ? { counterbore: request.counterbore } : {}), ...(request.countersink ? { countersink: request.countersink } : {}) },
  }
}
