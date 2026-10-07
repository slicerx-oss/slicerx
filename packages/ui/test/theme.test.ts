// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyTheme, createTheme, subban, onThemeChange, resolveColor, themeToCss, themeToVars, type Theme } from '../src/theme'
import { forge, subbanLight, themes } from '../src/themes'

const here = resolve(import.meta.dirname)
const tokensCss = readFileSync(resolve(here, '../src/tokens.css'), 'utf8')

function cssValue(css: string, name: string): string | undefined {
  const m = css.match(new RegExp(`${name}\\s*:\\s*([^;]+);`))
  return m?.[1]?.trim()
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(resolve(dir, d.name)) : [resolve(dir, d.name)]))
}

describe('theme', () => {
  it('subban maps onto every variable in tokens.css with the same value', () => {
    for (const [name, value] of Object.entries(themeToVars(subban))) {
      expect(cssValue(tokensCss, name), name).toBe(value)
    }
  })

  it('createTheme merges nested overrides on top of the base', () => {
    const t = createTheme({ name: 'x', colors: { purple: 'rebeccapurple' }, spacing: { unit: 4 } })
    expect(t.colors.purple).toBe('rebeccapurple')
    expect(t.colors.pink).toBe(subban.colors.pink)
    expect(t.fonts).toEqual(subban.fonts)
    expect(themeToVars(t)['--s-2']).toBe('4px')
    expect(themeToVars(t)['--gutter']).toBe('8px')
    expect(subban.colors.purple).toBe('#bd93f9')
  })

  it('ships dark and light variants plus an example rebrand', () => {
    expect(subban.scheme).toBe('dark')
    expect(subbanLight.scheme).toBe('light')
    expect(forge.fonts.body).not.toBe(subban.fonts.body)
    expect(forge.radius.lg).not.toBe(subban.radius.lg)
    expect(Object.keys(themes)).toEqual(['subban', 'subbanLight', 'forge'])
    for (const t of Object.values(themes)) {
      for (const [k, v] of Object.entries(t.colors)) expect(v, `${t.name}.${k}`).toMatch(/^(#[0-9a-f]{6}|rgb\(.+\))$/i)
    }
  })

  it('renders a stylesheet for server rendering', () => {
    const css = themeToCss(forge, '[data-sx-theme="forge"]')
    expect(css.startsWith('[data-sx-theme="forge"] {\n  color-scheme: dark;')).toBe(true)
    expect(css).toContain('--purple: #f0a43a;')
    expect(css).toContain('--r-lg: 8px;')
  })

  it('applies at runtime and notifies listeners', () => {
    const set = new Map<string, string>()
    const listeners = new Set<(e: Event) => void>()
    let received: Theme | undefined
    const el = {
      style: { setProperty: (k: string, v: string) => set.set(k, v), removeProperty: (k: string) => set.delete(k) },
      dataset: {} as Record<string, string>,
      dispatchEvent: (e: Event) => {
        listeners.forEach((l) => l(e))
        return true
      },
      addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
      removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
    }
    const off = onThemeChange((t) => (received = t), el as unknown as EventTarget)
    applyTheme(subbanLight, el as unknown as HTMLElement)
    expect(set.get('--ink-0')).toBe(subbanLight.colors.ink0)
    expect(set.get('color-scheme')).toBe('light')
    expect(el.dataset['sxTheme']).toBe('subban-light')
    expect(received?.name).toBe('subban-light')
    applyTheme(forge, el as unknown as HTMLElement)
    expect(set.get('--f-body')).toBe(forge.fonts.body)
    off()
  })

  it('resolves variable references to concrete colors for canvases', () => {
    expect(resolveColor(forge, forge.gradient.from)).toBe(forge.colors.purple)
    expect(resolveColor(subban, '#123456')).toBe('#123456')
  })

  it('no component hard-codes a color or a font', () => {
    const files = walk(resolve(here, '../src')).filter((f) => /\.(tsx?|css)$/.test(f) && !/theme(s|-provider|file|-library)?\.tsx?$|fonts\.ts$|icon-paths\.ts$|tokens\.css$/.test(f))
    expect(files.length).toBeGreaterThan(15)
    for (const f of files) {
      const text = readFileSync(f, 'utf8').replace(/url\("data:[^"]*"\)/g, '')
      expect(text, f).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(text, f).not.toMatch(/\brgba?\(/)
      expect(text, f).not.toMatch(/font-family:\s*["']/)
      expect(text, f).not.toMatch(/fontFamily/)
    }
  })
})
