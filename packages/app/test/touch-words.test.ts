// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { touchWords } from '../src/cad/touch-words'

describe('touchWords', () => {
  it('says tap and press and hold for click and right click', () => {
    expect(touchWords('Click a flat face, or the bed, where the shape goes.')).toBe('Tap a flat face, or the bed, where the shape goes.')
    expect(touchWords('Right click a step for more.')).toBe('Press and hold a step for more.')
    expect(touchWords('Double-click a sketch to edit it.')).toBe('Double-tap a sketch to edit it.')
  })

  it('drops a sentence that needs a key', () => {
    expect(touchWords('Click an edge between two flat faces. Shift and click adds more.')).toBe('Tap an edge between two flat faces.')
    expect(touchWords('Shift and click to add or remove an edge.')).toBe('')
    expect(touchWords('Click to start. Esc cancels.')).toBe('Tap to start.')
  })

  it('drops the typed size line', () => {
    expect(touchWords('Click to place the corner. Type a number to give exact sizes.')).toBe('Tap to place the corner.')
  })
})
