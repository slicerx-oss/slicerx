// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's box select, as in CAD tools: a box drawn left to right picks the objects fully inside it, one drawn right to
// left picks anything it touches. Objects are judged by their bounds on screen.
/** A box drawn left to right picks what is fully inside it; right to left, anything it touches. */
export function boxDir(x0: number, x1: number): 'inside' | 'touch' {
  return x1 >= x0 ? 'inside' : 'touch'
}

type ScreenBox = { l: number; r: number; t: number; b: number }

/** Whether a box picks an object with these screen bounds. */
export function boxPicks(box: ScreenBox, obj: ScreenBox, dir: 'inside' | 'touch'): boolean {
  if (dir === 'inside') return obj.l >= box.l && obj.r <= box.r && obj.t >= box.t && obj.b <= box.b
  return obj.l <= box.r && obj.r >= box.l && obj.t <= box.b && obj.b >= box.t
}
