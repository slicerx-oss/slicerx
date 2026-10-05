// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it, vi } from 'vitest'
import { noteViewClosing, takeViewClosing } from '../src/camera/closing'

describe('why a camera view closed', () => {
  afterEach(() => vi.useRealTimers())

  it('is taken once, and only while fresh', () => {
    vi.useFakeTimers()
    noteViewClosing('the back button')
    expect(takeViewClosing()).toBe('the back button')
    expect(takeViewClosing()).toBeNull()
    noteViewClosing('the printer left the printer list')
    vi.advanceTimersByTime(2500)
    expect(takeViewClosing()).toBeNull()
  })
})
