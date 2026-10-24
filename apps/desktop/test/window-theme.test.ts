// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment jsdom
import { createTheme, nocturne, THEME_EVENT, type Theme } from '@slicerx/ui/theme'
import { describe, expect, it } from 'vitest'
import { pageBackground } from '@slicerx/ui/theme'
import { followAppTheme } from '../src/window-theme'

const dark = nocturne
const light = createTheme({ scheme: 'light' })

describe('the window theme', () => {
  it('follows the app light or dark mode on every switch, once per change', () => {
    const calls: string[] = []
    const target = new EventTarget()
    const apply = (t: Theme) => target.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: t }))
    const off = followAppTheme(async (t) => void calls.push(t), target, async () => undefined, () => null)
    apply(light)
    apply(light)
    apply(dark)
    expect(calls).toEqual(['light', 'dark'])
    off()
    apply(light)
    expect(calls).toEqual(['light', 'dark'])
  })

  it('paints the window with the page background and saves it for the next launch, once per change', () => {
    const saved: string[] = []
    const target = new EventTarget()
    let bg: string | null = '#282a36'
    const apply = (t: Theme) => target.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: t }))
    followAppTheme(async () => undefined, target, async (c) => void saved.push(c), () => bg)
    apply(dark)
    apply(dark)
    bg = '#f6f5f2'
    apply(light)
    // a background that is not one solid color (none yet) keeps the last one
    bg = null
    apply(dark)
    expect(saved).toEqual(['#282a36', '#f6f5f2'])
  })

  it('reads the page background as #rrggbb, and only a solid one', () => {
    const el = document.createElement('div')
    document.body.append(el)
    el.style.backgroundColor = 'rgb(40, 42, 54)'
    expect(pageBackground(el)).toBe('#282a36')
    el.style.backgroundColor = 'rgba(40, 42, 54, 0.5)'
    expect(pageBackground(el)).toBeNull()
    el.style.backgroundColor = ''
    expect(pageBackground(el)).toBeNull()
    expect(pageBackground(null)).toBeNull()
    el.remove()
  })
})
