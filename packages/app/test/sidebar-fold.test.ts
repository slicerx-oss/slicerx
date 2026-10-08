// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useFold } from '../src/shell/fold'
import { loadPrefs, savePrefs } from '../src/state/prefs'
import { get, set } from '../src/state/store'

beforeEach(() => set({ sidebarFolds: {}, settingsMode: 'advanced' }))

describe('sidebar folds', () => {
  it('sections start open and fold on their own', () => {
    const printer = renderHook(() => useFold('printer'))
    const filament = renderHook(() => useFold('filament'))
    expect(printer.result.current[0]).toBe(true)
    act(() => printer.result.current[1]?.(false))
    expect(printer.result.current[0]).toBe(false)
    expect(filament.result.current[0]).toBe(true)
    expect(get().sidebarFolds).toEqual({ printer: true })
  })

  it('do not fold in Simple mode, so Simple shows no extra controls', () => {
    set({ settingsMode: 'simple', sidebarFolds: { printer: true } })
    const printer = renderHook(() => useFold('printer'))
    expect(printer.result.current).toEqual([true, null])
  })

  it('are stored, and a bad entry is dropped', () => {
    localStorage.clear()
    savePrefs({ ...loadPrefs(), sidebarFolds: { printer: true, filament: false } })
    expect(loadPrefs().sidebarFolds).toEqual({ printer: true, filament: false })
    localStorage.setItem('slicerx.prefs.v1', JSON.stringify({ sidebarFolds: { printer: 'yes', 'Bad Key': true, filament: true } }))
    expect(loadPrefs().sidebarFolds).toEqual({ filament: true })
  })
})
