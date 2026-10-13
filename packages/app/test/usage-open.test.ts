// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openUsage, takeUsageFocus } from '../src/pilot-connect/usage-open'
import { get } from '../src/state/store'

afterEach(() => vi.useRealTimers())

describe('See usage', () => {
  it('opens Settings at Account and asks the section into view once', () => {
    openUsage()
    expect(get().settingsOpen).toBe(true)
    expect(get().settingsSection).toBe('account')
    expect(takeUsageFocus()).toBe(true)
    expect(takeUsageFocus()).toBe(false)
  })

  it('lets a section drawn long after the press stay where it is', () => {
    vi.useFakeTimers()
    openUsage()
    vi.advanceTimersByTime(6000)
    expect(takeUsageFocus()).toBe(false)
  })
})
