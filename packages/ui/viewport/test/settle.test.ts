// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The still frames after motion. With ambient occlusion they fade it back in; without it each would draw the same
// picture again, and on software graphics a big preview takes seconds a frame.
import { describe, expect, it } from 'vitest'
import { settleLeft } from '../src/viewport'

/** Still frames drawn after a moving frame, at reduced quality (`low`) or not. */
function stillFrames(low: boolean, ao: boolean): number {
  let settle = settleLeft(3, true, low, ao)
  let n = 0
  while (settle > 0 && n < 10) {
    settle = settleLeft(settle, false, false, ao)
    n++
  }
  return n
}

describe('still frames after motion', () => {
  it('fades ambient occlusion in over three still frames', () => {
    expect(stillFrames(true, true)).toBe(3)
    expect(stillFrames(false, true)).toBe(3)
  })

  it('without ambient occlusion draws one still frame after a reduced one, and none after a full one', () => {
    expect(stillFrames(true, false)).toBe(1)
    expect(stillFrames(false, false)).toBe(0)
  })
})
