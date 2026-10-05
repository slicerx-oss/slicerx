// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A face pick that fails says what went wrong, not that every face is curved.
import { describe, expect, it } from 'vitest'
import { pickWords } from '../src/cad/panel-kit'

describe('face pick messages', () => {
  it('names the problem', () => {
    expect(pickWords(new Error('face: pick a flat face'))).toBe('That face is curved. Pick a flat face.')
    expect(pickWords(new Error('face: pick a flat face'), true)).toBe('That face is curved. Pick a flat face, or the bed.')
    expect(pickWords(new Error('face: the face has no area'))).toBe('That face has no area to work on. Pick a larger face.')
    expect(pickWords(new Error('triangle: out of range'))).toBe('The part changed under the pointer. Pick the face again.')
    expect(pickWords(new Error('mesh face: vertex 3 is not finite'))).toBe('This part has a damaged mesh, so its faces cannot be picked. Repair it first.')
    expect(pickWords(new Error('That object is gone. Pick a face again.'))).toBe('That object is gone. Pick a face again.')
    expect(pickWords(Object.assign(new Error('Canceled'), { name: 'AbortError' }))).toBeNull()
  })
})
