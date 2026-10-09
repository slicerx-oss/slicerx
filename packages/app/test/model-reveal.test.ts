// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model plays the plate reveal the first time it opens in a session and when a job opens while it shows; switching
// tabs back and forth never replays it, and reduced motion never plays it.
import { describe, expect, it } from 'vitest'
import { modelReveal, type RevealMemory } from '../src/viewport/model-reveal'

const slice = { model: false, jobSeq: 0 }
const model = { model: true, jobSeq: 0 }

describe('Model plate reveal', () => {
  it('plays the first time Model opens, and not when the tabs switch back and forth', () => {
    const m: RevealMemory = { modelSeen: false }
    expect(modelReveal(null, slice, m, false)).toBe(false)
    expect(modelReveal(slice, model, m, false)).toBe(true)
    expect(modelReveal(model, slice, m, false)).toBe(false)
    expect(modelReveal(slice, model, m, false)).toBe(false)
  })

  it('counts a view that starts on Model as its first open (the window reveal plays there)', () => {
    const m: RevealMemory = { modelSeen: false }
    expect(modelReveal(null, model, m, false)).toBe(false)
    expect(modelReveal(model, slice, m, false)).toBe(false)
    expect(modelReveal(slice, model, m, false)).toBe(false)
  })

  it('plays when a job opens while Model shows, and not for one opened on Slice', () => {
    const m: RevealMemory = { modelSeen: true }
    expect(modelReveal(model, { model: true, jobSeq: 1 }, m, false)).toBe(true)
    expect(modelReveal({ model: true, jobSeq: 1 }, { model: true, jobSeq: 1 }, m, false)).toBe(false)
    expect(modelReveal({ model: false, jobSeq: 1 }, { model: false, jobSeq: 2 }, m, false)).toBe(false)
    expect(modelReveal({ model: false, jobSeq: 2 }, { model: true, jobSeq: 2 }, m, false)).toBe(false)
  })

  it('never plays with reduced motion, and the first open still counts', () => {
    const m: RevealMemory = { modelSeen: false }
    expect(modelReveal(slice, model, m, true)).toBe(false)
    expect(m.modelSeen).toBe(true)
    expect(modelReveal(model, { model: true, jobSeq: 1 }, m, true)).toBe(false)
  })
})
