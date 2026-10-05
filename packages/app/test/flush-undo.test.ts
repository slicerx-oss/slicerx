// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { loadFlushData } from '../src/filament/flush'
import { history } from '../src/plate/history'
import { get } from '../src/state/store'

describe('flush tables', () => {
  it('refresh the flush values when they load without leaving an undo step', async () => {
    const h = history()
    const before = get().flush
    await loadFlushData()
    expect(get().flush).not.toBe(before)
    expect(h.canUndo()).toBe(false)
  })
})
