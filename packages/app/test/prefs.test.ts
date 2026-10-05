// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPrefs, savePrefs } from '../src/state/prefs'

const KEY = 'slicerx.prefs.v1'

describe('stored preferences', () => {
  beforeEach(() => localStorage.clear())

  it('falls back to defaults on corrupt JSON', () => {
    localStorage.setItem(KEY, '{not json')
    expect(loadPrefs().workspace).toBe('prepare')
  })

  it('drops invalid fields and keeps valid ones', () => {
    localStorage.setItem(KEY, JSON.stringify({ workspace: 'fleet', goal: 'extreme', recents: 'x', rails: { prepare: { left: false } } }))
    const p = loadPrefs()
    expect(p.workspace).toBe('fleet')
    expect(p.goal).toBe('standard')
    expect(p.recents).toEqual([])
    expect(p.rails['prepare']?.left).toBe(false)
  })

  it('leaves auto slice absent until it is saved, so the store picks the default', () => {
    localStorage.setItem(KEY, JSON.stringify({ workspace: 'prepare' }))
    expect(loadPrefs().autoSlice).toBeUndefined()
    localStorage.setItem(KEY, JSON.stringify({ autoSlice: false }))
    expect(loadPrefs().autoSlice).toBe(false)
    localStorage.setItem(KEY, JSON.stringify({ autoSlice: 'yes' }))
    expect(loadPrefs().autoSlice).toBe(true)
  })

  it('turns auto slice on for a fresh install, and off only by a saved choice or the browser test flag', async () => {
    const fresh = async () => {
      vi.resetModules()
      return (await import('../src/state/store')).get().autoSlice
    }
    sessionStorage.clear()
    expect(await fresh()).toBe(true)
    localStorage.setItem(KEY, JSON.stringify({ autoSlice: false }))
    expect(await fresh()).toBe(false)
    localStorage.clear()
    sessionStorage.setItem('sx-no-auto-slice', '1')
    expect(await fresh()).toBe(false)
    localStorage.setItem(KEY, JSON.stringify({ autoSlice: true }))
    expect(await fresh()).toBe(true)
    sessionStorage.clear()
  })

  it('round-trips', () => {
    savePrefs({ workspace: 'library', rails: {}, recents: ['slice'], easy: null, goal: 'fine', printerId: 'bay-2', scheme: 'light' })
    expect(loadPrefs()).toMatchObject({ workspace: 'library', recents: ['slice'], goal: 'fine', printerId: 'bay-2', scheme: 'light' })
  })
})
