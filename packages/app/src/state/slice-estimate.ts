// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// How long a plate's slice is expected to take, and whether that makes it a big slice. One rule for every caller:
// auto slice starts a small slice at once, even while a file is still opening (on the mesh shown first), and holds a
// big one until the open is over and the fit check is done with its copy of the meshes, so a big model's copies are
// not all alive at once. The estimate is the plate's last slice time, scaled to its triangles now, when the plate is
// still about the size it was then; else the plate's triangles times a factor from the bench. The functions are pure;
// the record of last slice times below them is the one piece of state.

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

/**
 * The expected slice time of a plate (ms): the last slice's time scaled by the plate's triangles against that slice's,
 * when the plate is still about that size (SAME_PLATE_RATIO), else the triangles times SLICE_MS_PER_TRIANGLE.
 */
export function expectedSliceMs(plate: PlateLike, last?: SliceTiming | null): number {
  const triangles = plateTriangles(plate)
  if (last && last.triangles > 0 && last.ms >= 0) {
    const ratio = triangles / last.triangles
    if (ratio >= 1 / SAME_PLATE_RATIO && ratio <= SAME_PLATE_RATIO) return last.ms * ratio
  }
  return triangles * SLICE_MS_PER_TRIANGLE
}

/** Whether the plate's slice is expected to take BIG_SLICE_MS or longer. */
export function isBigSlice(plate: PlateLike, last?: SliceTiming | null): boolean {
  return expectedSliceMs(plate, last) >= BIG_SLICE_MS
}

const timings = new Map<string, SliceTiming>()

/** Keeps a finished slice's timing for its plate (the plate tab's id). */
export function noteSliceTiming(plateId: string, timing: SliceTiming): void {
  timings.set(plateId, timing)
}

/** The last slice timing kept for a plate, if any. */
export function sliceTimingOf(plateId: string): SliceTiming | null {
  return timings.get(plateId) ?? null
}
