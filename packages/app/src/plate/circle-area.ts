// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The printable area of a round bed, in a leaf of its own: the generic bed (adapters/generic-bed.ts) loads with the
// shell, and the rest of the bed shape code (plate/bed-shape.ts and the box packer) stays out of it.

/** A ring of points around a circle of `diameter` mm whose box starts at 0, 0: the printable area of a round bed. */
export function circleArea(diameter: number, points = 72): [number, number][] {
  const r = diameter / 2
  return Array.from({ length: points }, (_, i) => {
    const a = (i / points) * Math.PI * 2
    return [round3(r + r * Math.cos(a)), round3(r + r * Math.sin(a))] as [number, number]
  })
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}
