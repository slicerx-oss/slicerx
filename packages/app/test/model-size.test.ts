// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The size under the 3D view is the object as it sits on the plate: scaling it (the handles or the fields) changes it.
import { describe, expect, it } from 'vitest'
import { modelSizeText } from '../src/workspaces/studio'

// A 10 x 20 x 30 mm box from two corners is enough for its bounds.
const parts = [{ positions: new Float32Array([0, 0, 0, 10, 20, 30]) }] as never
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('the model size under the view', () => {
  it('is the size as loaded with no scale', () => {
    expect(modelSizeText({ parts, transform: identity } as never)).toBe('10.0 x 20.0 x 30.0 mm')
  })

  it('follows a scale', () => {
    const tallTwice = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 5, 5, 0, 1]
    expect(modelSizeText({ parts, transform: tallTwice } as never)).toBe('10.0 x 20.0 x 60.0 mm')
  })

  it('is nothing with no object', () => {
    expect(modelSizeText(undefined)).toBeNull()
  })
})
