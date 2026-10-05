// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { startReadySignal } from '../src/lib/ready-signal'
import { set } from '../src/state/store'

describe('page marks for scripts', () => {
  it('marks the page busy while an arrange runs, and clears it when it is done', () => {
    const root = document.createElement('div')
    const stop = startReadySignal(root)
    expect(root.dataset['sxBusy']).toBeUndefined()
    set({ arranging: { done: 0, total: 0 } })
    expect(root.dataset['sxBusy']).toBe('arrange')
    set({ arranging: { done: 3, total: 8 } })
    expect(root.dataset['sxBusy']).toBe('arrange')
    set({ arranging: null })
    expect(root.dataset['sxBusy']).toBeUndefined()
    stop()
    set({ arranging: { done: 0, total: 0 } })
    expect(root.dataset['sxBusy']).toBeUndefined()
    set({ arranging: null })
  })
})
