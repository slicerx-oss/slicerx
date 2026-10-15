// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The new Model feel's developer flag: off by default, on only in developer mode, kept on this device, and heard by
// whoever listens when the palette command turns it over.
import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_FEEL_KEY, modelFeelFor, modelFeelStored, onModelFeel, toggleModelFeel } from '../src/cad/model-feel-flag'

afterEach(() => localStorage.removeItem(MODEL_FEEL_KEY))

describe('the Model feel flag', () => {
  it('is off by default and counts only in developer mode', () => {
    expect(modelFeelStored()).toBe(false)
    expect(modelFeelFor('developer')).toBe(false)
    localStorage.setItem(MODEL_FEEL_KEY, '1')
    expect(modelFeelFor('developer')).toBe(true)
    expect(modelFeelFor('expert')).toBe(false)
    expect(modelFeelFor('simple')).toBe(false)
  })

  it('turns over, tells its listeners, and stops telling one that left', () => {
    const heard: boolean[] = []
    const off = onModelFeel((on) => heard.push(on))
    expect(toggleModelFeel()).toBe(true)
    expect(localStorage.getItem(MODEL_FEEL_KEY)).toBe('1')
    expect(toggleModelFeel()).toBe(false)
    expect(localStorage.getItem(MODEL_FEEL_KEY)).toBeNull()
    off()
    toggleModelFeel()
    expect(heard).toEqual([true, false])
  })
})
