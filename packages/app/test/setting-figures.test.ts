// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Setting figures draw with theme classes only, so they render in the light and the dark theme alike.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { subban, subbanLight, themeToVars } from '@slicerx/ui'
import { createElement, Fragment } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { settingDef } from '../src/adapters/settings'
import { FIGURE_KEYS, hasSettingFigure, settingFigure } from '../src/lib/setting-figures'
import { settingTip } from '../src/lib/setting-tip'

const css = readFileSync(resolve(import.meta.dirname, '../../ui/src/styles.css'), 'utf8')
const tokens = readFileSync(resolve(import.meta.dirname, '../../ui/src/tokens.css'), 'utf8')
const figRules = css.split('\n').filter((l) => /\.sx-fig|\.sx-tip-fig|@keyframes fx-/.test(l))
const markup = (key: string) => renderToStaticMarkup(createElement(Fragment, null, settingFigure(key)))

describe('setting figures', () => {
  it('cover 30 to 50 user-visible settings, each with its own drawing', () => {
    expect(FIGURE_KEYS.length).toBeGreaterThanOrEqual(30)
    expect(FIGURE_KEYS.length).toBeLessThanOrEqual(50)
    for (const key of FIGURE_KEYS) {
      const def = settingDef(key)
      expect(def, key).toBeDefined()
      expect(['simple', 'advanced', 'expert'], key).toContain(def?.mode)
    }
    expect(settingFigure('gcode_flavor')).toBeNull()
    expect(hasSettingFigure('brim_width')).toBe(true)
  })

  it('draw with theme classes only: no colors, no inline styles', () => {
    const known = new Set([...css.matchAll(/\.(fx-[a-z0-9-]+)/g)].map((m) => m[1]))
    for (const key of FIGURE_KEYS) {
      const html = markup(key)
      expect(html, key).toMatch(/^<svg class="sx-fig" viewBox="0 0 224 96"/)
      expect(html, key).toMatch(/aria-label="[^"]+"/)
      expect(html, key).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|style=|fill="(?!url)|stroke="/i)
      for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1]!.split(/\s+/)) if (c.startsWith('fx-')) expect(known.has(c), `${key}: ${c}`).toBe(true)
      expect(html, key).not.toMatch(new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']'))
    }
  })

  for (const theme of [subban, subbanLight]) {
    it(`find every color they use in the ${theme.scheme} theme`, () => {
      const vars = themeToVars(theme)
      const used = new Set(figRules.flatMap((l) => [...l.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!)))
      expect(used.size).toBeGreaterThan(5)
      for (const v of used) {
        const local = figRules.some((l) => l.includes(`${v}:`))
        expect(local || v in vars || tokens.includes(`${v}:`), `${v} in ${theme.name}`).toBe(true)
      }
      for (const l of figRules) expect(l, l).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
      // Strokes stand out from the tooltip ground in this theme.
      expect(vars['--purple']).not.toBe(vars['--ink-1'])
      expect(vars['--muted']).not.toBe(vars['--ink-1'])
      const el = document.createElement('div')
      for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
      el.innerHTML = FIGURE_KEYS.map(markup).join('')
      expect(el.querySelectorAll('svg.sx-fig').length).toBe(FIGURE_KEYS.length)
    })
  }

  it('stop animating under reduced motion', () => {
    expect(css).toMatch(/:root\[data-motion="reduced"\] \.sx-fig \* \{ animation: none !important; \}/)
    expect(css).toMatch(/\.sx-tip\[data-still\] \.sx-fig \*/)
    const animated = FIGURE_KEYS.filter((k) => /fx-a-/.test(markup(k)))
    expect(animated).toEqual(expect.arrayContaining(['ironing_type', 'z_hop_types', 'retraction_length', 'wipe']))
  })

  it('come with the setting note, and the key only in developer mode', () => {
    const tip = settingTip('wall_loops')
    expect(tip?.title).toBe(settingDef('wall_loops')?.label)
    expect(tip?.body).toMatch(/loops/)
    expect(tip?.figure).toBeTruthy()
    expect(tip?.meta).toBeUndefined()
    expect(settingTip('wall_loops', true)?.meta).toBe('wall_loops')
    expect(settingTip('gcode_flavor')?.figure).toBeUndefined()
  })
})
