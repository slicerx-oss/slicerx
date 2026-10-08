// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { subban, subbanLight, THEME_EVENT, type Theme } from '@slicerx/ui/theme'
import { describe, expect, it } from 'vitest'
import { followAppTheme } from '../src/window-theme'

describe('the window theme', () => {
  it('follows the app light or dark mode on every switch, once per change', () => {
    const calls: string[] = []
    const target = new EventTarget()
    const apply = (t: Theme) => target.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: t }))
    const off = followAppTheme(async (t) => void calls.push(t), target)
    apply(subbanLight)
    apply(subbanLight)
    apply(subban)
    expect(calls).toEqual(['light', 'dark'])
    off()
    apply(subbanLight)
    expect(calls).toEqual(['light', 'dark'])
  })
})
