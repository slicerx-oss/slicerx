// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Icons drawn at 16px or smaller use their 16px versions when they have one, on a 16px grid at stroke 1.5.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SMALL_ICONS } from '../icons/small.mjs'
import { ICON_PATHS } from '../src/icons/icon-paths'
import { SMALL_ICON_PATHS } from '../src/icons/icon-small'
import { Icon, iconsReady } from '../src/icons/icon'
import { ThemeProvider } from '../src/theme-provider'

describe('16px icons', () => {
  it('draws a startup icon\'s 24px art at 16 until the 16px table arrives, so nothing pops in', async () => {
    const early = renderToStaticMarkup(<Icon name="check" size={16} />)
    expect(early).toContain(ICON_PATHS.check)
    expect(early).toContain('viewBox="0 0 24 24"')
    await iconsReady()
  })

  it('draws the 16px version at 16 and less, and the 24px drawing above', () => {
    const at16 = renderToStaticMarkup(<Icon name="check" size={16} />)
    expect(at16).toContain('viewBox="0 0 16 16"')
    expect(at16).toContain('stroke-width="1.5"')
    expect(at16).toContain(SMALL_ICON_PATHS.check!)
    expect(at16).toContain('data-icon-small="true"')
    const at12 = renderToStaticMarkup(<Icon name="check" size={12} />)
    expect(at12).toContain(SMALL_ICON_PATHS.check!)
    const at18 = renderToStaticMarkup(<Icon name="check" size={18} />)
    expect(at18).toContain('viewBox="0 0 24 24"')
    expect(at18).toContain('stroke-width="1.75"')
    expect(at18).toContain(ICON_PATHS.check)
  })

  it('takes the small flag where CSS sets the size, and falls back to the 24px drawing without a 16px one', () => {
    expect(renderToStaticMarkup(<Icon name="check" small />)).toContain(SMALL_ICON_PATHS.check!)
    expect(renderToStaticMarkup(<Icon name="check" size={14} small={false} />)).toContain(ICON_PATHS.check)
    const none = renderToStaticMarkup(<Icon name="layers" size={16} />)
    expect(none).toContain('viewBox="0 0 24 24"')
    expect(none).toContain(ICON_PATHS.layers)
  })

  it('draws an integrator\'s override as given, at any size', () => {
    const html = renderToStaticMarkup(
      <ThemeProvider icons={{ check: '<path d="M1 1h22"/>' }}>
        <Icon name="check" size={16} />
      </ThemeProvider>,
    )
    expect(html).toContain('<path d="M1 1h22"/>')
    expect(html).toContain('viewBox="0 0 24 24"')
  })

  it('generates the table from icons/small.mjs', () => {
    expect(SMALL_ICON_PATHS).toEqual(SMALL_ICONS)
  })

  it('keeps every 16px drawing to the grid: at most three primitives, no dashes, inside 16', () => {
    for (const [name, markup] of Object.entries(SMALL_ICONS)) {
      expect((markup.match(/<(path|circle|rect|line|polyline|ellipse)\b/g) ?? []).length, name).toBeLessThanOrEqual(3)
      expect(markup, name).not.toContain('dasharray')
      for (const n of markup.match(/-?\d*\.?\d+/g) ?? []) expect(Math.abs(Number(n)), `${name} ${n}`).toBeLessThanOrEqual(16)
    }
  })
})

describe('the icon sources', () => {
  // Runs the generator on a copy of the sources with one change, so the real files are never touched.
  function generate(edit: (dir: string) => void): string {
    const pkg = resolve(import.meta.dirname, '..')
    const dir = mkdtempSync(join(tmpdir(), 'sx-icons-'))
    cpSync(join(pkg, 'icons'), join(dir, 'icons'), { recursive: true })
    cpSync(join(pkg, 'scripts'), join(dir, 'scripts'), { recursive: true })
    cpSync(join(pkg, 'src/icons'), join(dir, 'src/icons'), { recursive: true })
    edit(dir)
    try {
      return execFileSync('node', [join(dir, 'scripts/gen-icons.mjs')], { stdio: 'pipe' }).toString()
    } catch (e) {
      return String((e as { stderr?: Buffer }).stderr ?? e)
    }
  }

  it('refuses an icon drawn in two sources', () => {
    const out = generate((dir) => {
      const f = join(dir, 'icons/slice.mjs')
      writeFileSync(f, readFileSync(f, 'utf8').replace(/export const SLICE_ICONS = \{/, "export const SLICE_ICONS = { printer: '<path d=\"M1 1h1\"/>',"))
    })
    expect(out).toContain('icons drawn twice')
    expect(out).toContain('printer')
  })

  it('refuses a 16px drawing with no 24px one', () => {
    const out = generate((dir) => {
      const f = join(dir, 'icons/small.mjs')
      writeFileSync(f, readFileSync(f, 'utf8').replace('export const SMALL_ICONS = {', "export const SMALL_ICONS = {\n  'no-such-icon': '<path d=\"M1 1h1\"/>',"))
    })
    expect(out).toContain('no 24px drawing: no-such-icon')
  })
})

describe('the Slice icons', () => {
  it('tells the four goals apart, and Draft apart from layers', () => {
    const goals = ['preset-draft', 'preset-standard', 'preset-fine', 'preset-strong'] as const
    expect(new Set(goals.map((g) => ICON_PATHS[g])).size).toBe(4)
    expect(ICON_PATHS['preset-draft']).not.toBe(ICON_PATHS.layers)
    for (const g of goals) expect(SMALL_ICON_PATHS[g], g).toBeTruthy()
  })

  it('has a 16px version of every icon the Slice sidebar draws at 16px', () => {
    const sidebar = ['printer', 'spool', 'cube', 'sliders', 'settings', 'send-to-printer', 'slice', 'lock', 'unlock', 'show', 'hide', 'more', 'search', 'alert', 'chevron-down', 'chevron-right', 'plus', 'check', 'close', 'negative-part', 'support-blocker', 'support-enforcer', 'select-by-filament', 'move-to-plate', 'skip-object', 'color-by'] as const
    expect(sidebar.filter((n) => !SMALL_ICON_PATHS[n])).toEqual([])
  })
})
