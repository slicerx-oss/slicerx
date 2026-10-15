// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { describe, expect, it } from 'vitest'
import { applyPreset, clearPreset, resolvePreset } from '../src/lookfeel'
import { applyTheme, clearTheme, createTheme, subban, themeToVars } from '../src/theme'

function element() {
  const props = new Map<string, string>()
  return {
    dataset: {},
    style: {
      setProperty: (key: string, value: string) => { props.set(key, value) },
      removeProperty: (key: string) => { props.delete(key) },
      getPropertyValue: (key: string) => props.get(key) ?? '',
      getPropertyPriority: () => '',
    },
    dispatchEvent: () => true,
  } as unknown as HTMLElement
}

const preset = resolvePreset('slicerx')
const coloredLook = (accent: 'green' | 'blue') => ({ ...preset, look: { ...preset.look, accent } })

describe('edition visual colors', () => {
  it('keeps edition colors after a look change, then restores the latest look when removed', () => {
    const el = element()
    applyPreset(coloredLook('green'), el)
    applyTheme(createTheme({ visuals: { '--accent': '#126789', '--ti-sk': '#abcdef' } }), el)
    expect(el.style.getPropertyValue('--accent')).toBe('#126789')
    applyPreset(coloredLook('blue'), el)
    expect(el.style.getPropertyValue('--accent')).toBe('#126789')
    expect(el.style.getPropertyValue('--ti-sk')).toBe('#abcdef')
    applyTheme(subban, el)
    expect(el.style.getPropertyValue('--accent')).toBe('var(--blue)')
    expect(el.style.getPropertyValue('--ti-sk')).toBe('')
  })

  it('handles theme-first application and cleanup without retaining colors from a previous edition', () => {
    const el = element()
    applyTheme(createTheme({ visuals: { '--accent': '#126789', '--stage-a1': '#abcdef' } }), el)
    applyPreset(coloredLook('green'), el)
    expect(el.style.getPropertyValue('--accent')).toBe('#126789')
    clearPreset(el)
    expect(el.style.getPropertyValue('--accent')).toBe('#126789')
    clearTheme(el)
    expect(el.style.getPropertyValue('--accent')).toBe('')
    expect(el.style.getPropertyValue('--stage-a1')).toBe('')
  })

  it('includes overrides in server-rendered variables without changing the default theme', () => {
    const before = themeToVars(subban)
    const themed = createTheme({ visuals: { '--stage-a1': '#abcdef', '--glyph-picked-line': '#123456' } })
    expect(themeToVars(themed)['--stage-a1']).toBe('#abcdef')
    expect(themeToVars(themed)['--glyph-picked-line']).toBe('#123456')
    expect(themeToVars(subban)).toEqual(before)
  })
})
