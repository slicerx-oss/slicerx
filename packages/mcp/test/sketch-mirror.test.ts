// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The frame a client gives with its v, as the engine reads it (givenFrame), and a sketch mirrored in v onto it
// (sketch-mirror.ts): every point and every turn of every loop form.
import { expect, it } from 'vitest'
import { givenFrame } from '../src/cad'
import { mirroredLoop, mirroredPlacement } from '../src/sketch-mirror'

const near = (a: readonly number[], b: readonly number[]) => a.forEach((x, k) => expect(x).toBeCloseTo(b[k]!, 9))

it('refuses a frame whose axes are not square, naming which and by how much, and scales each to 1 long', () => {
  expect(() => givenFrame({ origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0.1, 1] })).toThrow(
    'frame: with v given, u, v and normal must be at right angles to each other, within 0.0001; here v and normal meet at 84.289 degrees. Fix them, or leave v out and v is normal × u.',
  )
  expect(() => givenFrame({ origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0.02], v: [0, 0, 1] })).toThrow('here u and v meet at 88.854 degrees. Fix them')
  // a frame read back from JSON is square well within the tolerance
  expect(givenFrame({ origin: [0, 0, 0], normal: [0, 1, 0], u: [1, 0, 0.00001], v: [0, 0, 1] }).mirrored).toBe(true)
  // a v with no u: u is v x normal, the frame the way round it is
  const f = givenFrame({ origin: [0, 0, 0], normal: [0, 1, 0], v: [0, 0, 1] })
  expect(f.mirrored).toBe(false)
  near(f.frame.u, [-1, 0, 0])
  near(f.frame.v, [0, 0, 1])
  // axes of any length are scaled to 1, as before
  const long = givenFrame({ origin: [0, 0, 0], normal: [0, 3, 0], u: [2, 0, 0], v: [0, 0, 0.5] })
  expect(long.mirrored).toBe(true)
  near(long.frame.normal, [0, 1, 0])
  near(long.frame.u, [1, 0, 0])
  near(long.frame.v, [0, 0, -1])
})

it('mirrors every form of loop in v, turns included', () => {
  expect(mirroredLoop({ type: 'ellipse', center: [1, 2], widthMm: 4, heightMm: 2, angleDeg: 30 })).toEqual({ type: 'ellipse', center: [1, -2], widthMm: 4, heightMm: 2, angleDeg: -30 })
  expect(mirroredLoop({ type: 'spline', points: [[0, 1], [2, 3]] })).toEqual({ type: 'spline', points: [[0, -1], [2, -3]] })
  const chain = {
    start: [0, 1],
    segments: [
      { type: 'line', to: [4, 1] },
      { type: 'line', lengthMm: 2, angleDeg: 90 },
      { type: 'line', lengthMm: 2, turnDeg: 45 },
      { type: 'arc', center: [4, 5], sweepDeg: 90 },
      { type: 'arc', to: [0, 7], through: [2, 8] },
      { type: 'arc', to: [0, 1], radiusMm: 3, large: true },
      { type: 'arc', to: [1, 1], radiusMm: 3, clockwise: true },
      { type: 'spline', points: [[1, 2]], to: [0, 1] },
    ],
  }
  expect(mirroredLoop(chain)).toEqual({
    start: [0, -1],
    segments: [
      { type: 'line', to: [4, -1] },
      { type: 'line', lengthMm: 2, angleDeg: -90 },
      { type: 'line', lengthMm: 2, turnDeg: -45 },
      { type: 'arc', center: [4, -5], sweepDeg: -90 },
      { type: 'arc', to: [0, -7], through: [2, -8] },
      { type: 'arc', to: [0, -1], radiusMm: 3, large: true, clockwise: true },
      { type: 'arc', to: [1, -1], radiusMm: 3, clockwise: false },
      { type: 'spline', points: [[1, -2]], to: [0, -1] },
    ],
  })
  expect(mirroredPlacement('circle', undefined)).toBeUndefined()
})
