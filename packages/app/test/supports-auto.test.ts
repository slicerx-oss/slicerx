// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { matchGoal, resolveConfig } from '../src/adapters/config'
import { profileReady, startProfileSync } from '../src/state/profile-sync'
import { get, set } from '../src/state/store'

describe('Supports control over a maker preset', () => {
  it('Auto turns supports on in the resolved config', async () => {
    startProfileSync()
    set({ printerModel: { vendor: 'Bambu Lab', model: 'P1S' }, easyTouched: [] })
    await profileReady()
    expect(resolveConfig(get().easy, get().overrides)['enable_support']).toBeFalsy()
    // What the Prepare panel's Supports control does.
    set((s) => {
      const easy = { ...s.easy, supports: 'auto' as const }
      return { easy, goal: matchGoal(easy) ?? 'custom', easyTouched: [...new Set([...s.easyTouched, 'supports'])] }
    })
    await profileReady()
    expect(resolveConfig(get().easy, get().overrides)['enable_support']).toBe(true)
  })
})
