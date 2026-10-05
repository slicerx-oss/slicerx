// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// "Extrude into the face" on a cut must not send the cut out into the air.
import { describe, expect, it } from 'vitest'
import { flipFor, goesIntoFace } from '../src/cad/extrude-direction'

describe('extrude direction switch', () => {
  it('reads on for a plain cut and off for a plain join or new body', () => {
    expect(goesIntoFace(false, 'cut')).toBe(true)
    expect(goesIntoFace(false, 'join')).toBe(false)
    expect(goesIntoFace(false, 'new')).toBe(false)
  })

  it('keeps a cut into the face unflipped when the switch is on', () => {
    expect(flipFor(true, 'cut')).toBe(false)
    expect(flipFor(false, 'cut')).toBe(true)
    expect(flipFor(true, 'join')).toBe(true)
    expect(flipFor(false, 'new')).toBe(false)
  })

  it('round trips for every operation', () => {
    for (const op of ['new', 'join', 'cut'] as const) {
      for (const on of [true, false]) expect(goesIntoFace(flipFor(on, op), op)).toBe(on)
    }
  })
})
