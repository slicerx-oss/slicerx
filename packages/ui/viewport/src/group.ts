// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A multi-selection moved, turned or scaled as one: one change in the bed's frame applied to each object's transform,
// so the objects keep their places relative to each other. Transforms are column-major 4x4, mm, bed frame.
import { Matrix4 } from 'three'

export type V3 = [number, number, number]

/** Each start transform with `delta` (a bed-frame change) applied: delta times start. */
export function applyToAll(starts: ReadonlyMap<string, readonly number[]>, delta: readonly number[]): Map<string, number[]> {
  const d = new Matrix4().fromArray(Array.from(delta))
  const out = new Map<string, number[]>()
  for (const [id, m] of starts) out.set(id, new Matrix4().fromArray(Array.from(m)).premultiply(d).toArray())
  return out
}

/** The box round several boxes, and its middle. */
export function groupBounds(boxes: readonly { min: V3; max: V3 }[]): { min: V3; max: V3; center: V3 } | null {
  if (boxes.length === 0) return null
  const min: V3 = [Infinity, Infinity, Infinity]
  const max: V3 = [-Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, b.min[k]!)
      max[k] = Math.max(max[k]!, b.max[k]!)
    }
  }
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] }
}

/** A uniform scale by `f` about `anchor` in the bed's frame. */
export function scaleAbout(f: number, anchor: V3): number[] {
  const [x, y, z] = anchor
  return [f, 0, 0, 0, 0, f, 0, 0, 0, 0, f, 0, x * (1 - f), y * (1 - f), z * (1 - f), 1]
}
