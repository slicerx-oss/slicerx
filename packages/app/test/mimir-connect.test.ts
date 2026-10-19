// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPrefs, savePrefs } from '../src/state/prefs'

const KEY = 'slicerx.prefs.v1'

describe('mimir before a model is connected', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts a fresh install at the connect step, not off', async () => {
    vi.resetModules()
    const { get, pilotState } = await import('../src/state/store')
    expect(get().pilot).toEqual({ mode: 'unset' })
    expect(pilotState()).toBe('connect')
  })

  it('keeps mimir off for someone who turned it off, and on for installs from before setup asked', async () => {
    const { pilotState } = await import('../src/state/store')
    expect(pilotState({ pilot: { mode: 'off' }, setupPilotOff: false })).toBe('off')
    expect(pilotState({ pilot: { mode: 'unset' }, setupPilotOff: true })).toBe('off')
    expect(pilotState({ pilot: null, setupPilotOff: false })).toBe('on')
    expect(pilotState({ pilot: { mode: 'on', provider: 'openai' }, setupPilotOff: false })).toBe('on')
  })

  it('stores the not yet connected state apart from off', () => {
    savePrefs({ workspace: 'prepare', rails: {}, recents: [], easy: null, goal: 'standard', printerId: null, scheme: 'dark', pilot: { mode: 'unset' } })
    expect(loadPrefs().pilot).toEqual({ mode: 'unset' })
    localStorage.setItem(KEY, JSON.stringify({ pilot: { mode: 'maybe' } }))
    expect(loadPrefs().pilot).toBeNull()
  })

})
