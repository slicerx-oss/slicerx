// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The prefs' second copy in the desktop shell's file: each save goes there too, and a launch takes the newer copy, so
// a quit right after a change loses nothing even when the web view had not written its storage yet.
import { afterEach, describe, expect, it } from 'vitest'
import { hasStoredPrefs, loadPrefs, savePrefs, setPrefsMirror } from '../src/state/prefs'

const KEY = 'slicerx.prefs.v1'
const g = globalThis as { __sxPrefs?: unknown }

afterEach(() => {
  setPrefsMirror(null)
  delete g.__sxPrefs
  localStorage.clear()
})

describe('prefs survive a quit right after a change', () => {
  it('sends every save to the shell, stamped with its time', () => {
    const sent: string[] = []
    setPrefsMirror((json) => sent.push(json))
    savePrefs({ ...loadPrefs(), settingsMode: 'expert' })
    expect(sent).toHaveLength(1)
    const p = JSON.parse(sent[0]!) as { settingsMode: string; savedAt: number }
    expect(p.settingsMode).toBe('expert')
    expect(p.savedAt).toBeGreaterThan(0)
    expect(localStorage.getItem(KEY)).toBe(sent[0])
  })

  it('takes the shell\'s copy when the web view lost the last change', () => {
    localStorage.setItem(KEY, JSON.stringify({ workspace: 'prepare', settingsMode: 'simple', savedAt: 100 }))
    g.__sxPrefs = JSON.stringify({ workspace: 'prepare', settingsMode: 'expert', savedAt: 200 })
    expect(loadPrefs().settingsMode).toBe('expert')
  })

  it('keeps the web view\'s copy when it is the newer one', () => {
    localStorage.setItem(KEY, JSON.stringify({ workspace: 'prepare', settingsMode: 'advanced', savedAt: 300 }))
    g.__sxPrefs = JSON.stringify({ workspace: 'prepare', settingsMode: 'expert', savedAt: 200 })
    expect(loadPrefs().settingsMode).toBe('advanced')
  })

  it('counts as having run before when only the shell\'s copy is there', () => {
    expect(hasStoredPrefs()).toBe(false)
    g.__sxPrefs = JSON.stringify({ workspace: 'prepare', savedAt: 1 })
    expect(hasStoredPrefs()).toBe(true)
    expect(loadPrefs().workspace).toBe('prepare')
  })

  it('reads prefs saved before the time stamp as the oldest', () => {
    localStorage.setItem(KEY, JSON.stringify({ workspace: 'prepare', settingsMode: 'simple' }))
    g.__sxPrefs = JSON.stringify({ workspace: 'prepare', settingsMode: 'expert', savedAt: 1 })
    expect(loadPrefs().settingsMode).toBe('expert')
  })
})
