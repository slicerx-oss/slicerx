// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How long a plate's slice is expected to take, and whether that makes it a big slice. One rule for every caller:
// auto slice starts a small slice at once, even while a file is still opening (on the mesh shown first), and holds a
// big one until the open is over and the fit check is done with its copy of the meshes, so a big model's copies are
// not all alive at once. The estimate is the median of the plate's last three slice times, each scaled to its triangles
// now, when those slices were of about this size; with fewer than three such slices it is the plate's triangles times
// a factor from the bench, so one slow slice on a busy machine cannot put a normal plate on Slice. The functions are
// pure; the record of recent slice times below them is the one piece of state.

/** A slice that takes this long or longer is a big one (ms). */
export const BIG_SLICE_MS = 1500

/**
 * Engine wall time per triangle (ms), from the bench's slices on Windows: 0.0016 to 0.0023 on a 92k triangle part,
 * 0.0016 to 0.0026 on a 1.4 million triangle part. The higher end, so a plate near the line counts as big.
 */
export const SLICE_MS_PER_TRIANGLE = 0.0025

/** A slice that ran: the triangles it sliced and how long it took (the result's wall time). */
export interface SliceTiming {
  triangles: number
  ms: number
}

/** The plate as the estimate reads it: each object's parts, and whether it prints. */
export type PlateLike = readonly { printable?: boolean; parts: readonly { indices: ArrayLike<number> }[] }[]

/** The triangles the slice would read: every part of every object that prints. */
export function plateTriangles(plate: PlateLike): number {
  let n = 0
  for (const o of plate) if (o.printable !== false) for (const p of o.parts) n += Math.floor(p.indices.length / 3)
  return n
}

/**
 * A last slice speaks for the plate when the plate has between half and twice its triangles: the same model with an
 * edit, or new settings. Far from that it is another model, and a small slice's fixed costs say nothing about a big one.
 */
export const SAME_PLATE_RATIO = 2

/** Slice times that decide together: their median, so one outlier cannot. */
export const RECENT_SLICES = 3

/**
 * The expected slice time of a plate (ms): the median of the recent slices' times, each scaled by the plate's
 * triangles against that slice's, when RECENT_SLICES of them were of about this size (SAME_PLATE_RATIO); else the
 * triangles times SLICE_MS_PER_TRIANGLE.
 */
export function expectedSliceMs(plate: PlateLike, recent: readonly SliceTiming[] = []): number {
  const triangles = plateTriangles(plate)
  const scaled = recent
    .filter((t) => t.triangles > 0 && t.ms >= 0 && triangles / t.triangles >= 1 / SAME_PLATE_RATIO && triangles / t.triangles <= SAME_PLATE_RATIO)
    .map((t) => (t.ms * triangles) / t.triangles)
    .sort((a, b) => a - b)
  if (scaled.length >= RECENT_SLICES) return scaled[Math.floor(scaled.length / 2)]!
  return triangles * SLICE_MS_PER_TRIANGLE
}

/** Whether the plate's slice is expected to take BIG_SLICE_MS or longer. */
export function isBigSlice(plate: PlateLike, recent: readonly SliceTiming[] = []): boolean {
  return expectedSliceMs(plate, recent) >= BIG_SLICE_MS
}

const timings = new Map<string, SliceTiming[]>()

/** Keeps a finished slice's timing for its plate (the plate tab's id), the last RECENT_SLICES of them. */
export function noteSliceTiming(plateId: string, timing: SliceTiming): void {
  timings.set(plateId, [...(timings.get(plateId) ?? []), timing].slice(-RECENT_SLICES))
}

/** The recent slice timings kept for a plate, oldest first. */
export function sliceTimingsOf(plateId: string): readonly SliceTiming[] {
  return timings.get(plateId) ?? []
}
