// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Model feel's flag: on by default in every settings mode, turned off only by a developer on this device, and heard
// by whoever listens when the palette command turns it over.
import { afterEach, describe, expect, it } from 'vitest'
import { MODEL_FEEL_KEY, modelFeelFor, modelFeelOffStored, onModelFeel, toggleModelFeel } from '../src/cad/model-feel-flag'

afterEach(() => localStorage.removeItem(MODEL_FEEL_KEY))

describe('the Model feel flag', () => {
  it('is on by default, and the off switch counts only in developer mode', () => {
    expect(modelFeelOffStored()).toBe(false)
    for (const mode of ['simple', 'advanced', 'expert', 'developer']) expect(modelFeelFor(mode)).toBe(true)
    localStorage.setItem(MODEL_FEEL_KEY, '0')
    expect(modelFeelFor('developer')).toBe(false)
    expect(modelFeelFor('expert')).toBe(true)
    expect(modelFeelFor('simple')).toBe(true)
    // the old "on" value from the developer flag keeps it on
    localStorage.setItem(MODEL_FEEL_KEY, '1')
    expect(modelFeelFor('developer')).toBe(true)
  })

  it('turns over, tells its listeners, and stops telling one that left', () => {
    const heard: boolean[] = []
    const off = onModelFeel((on) => heard.push(on))
    expect(toggleModelFeel()).toBe(false)
    expect(localStorage.getItem(MODEL_FEEL_KEY)).toBe('0')
    expect(toggleModelFeel()).toBe(true)
    expect(localStorage.getItem(MODEL_FEEL_KEY)).toBeNull()
    off()
    toggleModelFeel()
    expect(heard).toEqual([false, true])
  })
})
