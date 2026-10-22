// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { contrast, mixHex } from '../src/color'
import { AXIS_COLORS, SURFACE_STEPS, surfaceTextVars } from '../src/surface-text'
import { createTheme, subban, themeToVars } from '../src/theme'
import { BUNDLED_THEMES } from '../src/theme-bundle'
import { themeColors, type ContrastLevel, type ColorVision } from '../src/themefile'

const tokensCss = readFileSync(resolve(import.meta.dirname, '../src/tokens.css'), 'utf8')
const rootBlock = tokensCss.slice(tokensCss.indexOf(':root {'), tokensCss.indexOf('\n}\n', tokensCss.indexOf(':root {')))
const cssValue = (css: string, name: string) => css.match(new RegExp(`\\s${name}\\s*:\\s*([^;]+);`))?.[1]?.trim()
const pct = (v: string) => Number.parseFloat(v) / 100

const LEVELS: ContrastLevel[] = ['standard', 'higher']
const VISIONS: ColorVision[] = ['standard', 'redgreen', 'blueyellow']

describe('text and marks on raised surfaces, every bundled theme', () => {
  for (const t of BUNDLED_THEMES) {
    it(`${t.id}: fields, the selected segment, status pills and axis letters reach the spec ratios`, () => {
      for (const level of LEVELS) {
        for (const vision of VISIONS) {
          const c = themeColors(t, { contrast: level, colorVision: vision })
          const v = surfaceTextVars(c, t.isDark ? 'dark' : 'light')
          const tag = `${t.id} ${level} ${vision}`
          const card = t.isDark ? mixHex(c.ink1, c.fg, SURFACE_STEPS.card) : c.ink2
          const field = t.isDark ? mixHex(c.ink1, c.fg, SURFACE_STEPS.field) : '#ffffff'
          const selectedOn = (a: string) => c.controlSelected ?? (t.isDark ? mixHex(c.ink1, c.fg, SURFACE_STEPS.selected) : mixHex('#ffffff', a, SURFACE_STEPS.selectedTint))
          // page text on the page, the surface and cards
          for (const g of [c.ink0, c.ink2, card]) for (const k of ['fg', 'muted', 'dim'] as const) expect(contrast(c[k], g), `${tag} ${k} on ${g}`).toBeGreaterThanOrEqual(4.5)
          // fields and segmented tracks
          for (const k of ['--field-muted', '--field-dim'] as const) expect(contrast(v[k] as string, field), `${tag} ${k}`).toBeGreaterThanOrEqual(4.5)
          expect(contrast(c.fg, field), `${tag} fg on field`).toBeGreaterThanOrEqual(4.5)
          // the selected segment, for each accent a person can pick
          for (const [name, a] of [['purple', c.purple], ['pink', c.pink], ['cyan', c.cyan], ['green', c.green], ['orange', c.orange], ['blue', c.blue as string]] as const) {
            const lift = pct(v[`--control-selected-lift-${name}`] as string)
            const sel = selectedOn(a)
            expect(contrast(v['--control-selected-fg'] as string, sel), `${tag} selected label on ${sel}`).toBeGreaterThanOrEqual(4.5)
            expect(contrast(v['--control-selected-muted'] as string, sel), `${tag} selected secondary on ${sel}`).toBeGreaterThanOrEqual(4.5)
            expect(contrast(mixHex(a, v['--control-selected-fg'] as string, lift), sel), `${tag} accent ${a} icon on ${sel}`).toBeGreaterThanOrEqual(3)
          }
          // status colors as text, on each surface and on their own tint
          const tints = { red: 0.13, green: 0.12, orange: 0.13, cyan: 0.12, pink: 0.13, purple: 0.14 } as const
          for (const [k, tint] of Object.entries(tints) as [keyof typeof tints, number][]) {
            const ink = v[`--${k}-text`] as string
            for (const g of [c.ink0, c.ink1, c.ink2, card, field, ...[c.ink1, c.ink2, card].map((x) => mixHex(x, c[k], tint))]) expect(contrast(ink, g), `${tag} ${k} text on ${g}`).toBeGreaterThanOrEqual(4.5)
          }
          if (t.isDark) for (const a of ['x', 'y', 'z'] as const) expect(contrast(v[`--axis-${a}-text`] as string, field), `${tag} axis ${a}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    })
  }

  it('only Solarized Dark sets its own selected fill, and there the accent icon keeps its tone', () => {
    for (const t of BUNDLED_THEMES) expect(themeColors(t).controlSelected, t.id).toBe(t.id === 'solarized-dark' ? '#153e48' : undefined)
    const sol = themeColors(BUNDLED_THEMES.find((t) => t.id === 'solarized-dark') as (typeof BUNDLED_THEMES)[number])
    const v = surfaceTextVars(sol, 'dark')
    expect(v['--control-selected-lift']).toBe('0%')
    expect(v['--control-selected-lift-purple']).toBe('0%')
    expect(themeToVars({ ...subban, colors: sol })['--control-selected']).toBe('#153e48')
    expect(contrast(sol.purple, '#153e48')).toBeGreaterThanOrEqual(3)
    expect(contrast(v['--control-selected-fg'] as string, '#153e48')).toBeGreaterThanOrEqual(4.5)
  })

  it('moves only lightness: the selected label and status text keep their hue family', () => {
    const v = surfaceTextVars(subban.colors, 'dark')
    expect(v['--control-selected-fg']).toBe(subban.colors.fg)
    expect(v['--green-text']).toBe(subban.colors.green)
    expect(v['--red-text']).not.toBe(subban.colors.red)
  })

  it('applyTheme carries the vars, and a theme with non-hex colors keeps the stylesheet defaults', () => {
    expect(themeToVars(subban)['--field-muted']).toBe(surfaceTextVars(subban.colors, 'dark')['--field-muted'])
    const plain = createTheme({ colors: { fg: 'var(--x)' } })
    expect(themeToVars(plain)['--field-muted']).toBeUndefined()
  })
})

describe('tokens.css agrees with the derivation', () => {
  it('the :root values are Subban dark', () => {
    for (const [k, val] of Object.entries(surfaceTextVars(subban.colors, 'dark'))) expect(cssValue(rootBlock, k), k).toBe(val)
  })
  it('the surface steps are the ones tokens.css draws', () => {
    expect(cssValue(rootBlock, '--surface-card')).toBe(`color-mix(in srgb, var(--ink-1), var(--fg) ${Math.round(SURFACE_STEPS.card * 100)}%)`)
    expect(cssValue(rootBlock, '--field-bg')).toBe(`color-mix(in srgb, var(--ink-1), var(--fg) ${Math.round(SURFACE_STEPS.field * 100)}%)`)
    expect(cssValue(rootBlock, '--control-selected')).toBe(`color-mix(in srgb, var(--ink-1), var(--fg) ${Math.round(SURFACE_STEPS.selected * 100)}%)`)
    expect(tokensCss).toContain(`--control-selected: color-mix(in srgb, var(--accent) ${Math.round(SURFACE_STEPS.selectedTint * 100)}%, #ffffff);`)
    expect(tokensCss).toContain('--field-bg: #ffffff;')
  })
  it('the axis colors match', () => {
    for (const a of ['x', 'y', 'z'] as const) expect(cssValue(rootBlock, `--axis-${a}`)).toBe(AXIS_COLORS[a])
  })
})
