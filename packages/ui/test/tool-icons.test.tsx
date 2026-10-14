// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The shaded tool icons: every one drawn at 32, 24 and 16 px, colored only through the set's classes (so a theme
// recolors them), the 16 px ones whole pixels only, and ToolIcon drawing the size it is asked for.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TOOL_ICON_GROUPS, TOOL_ICONS, ToolIcon, type ToolIconName } from '../src/icons/tool-icon'

const CLASSES = new Set(['t1', 't2', 't3', 'a1', 'a2', 'a3', 'hl', 'nos', 'po', 'pa', 'sh', 'sh3', 'hi', 'out', 'edge', 'mesh', 'ao', 'lu', 'lg', 'lw', 'ln', 'px'])
const names = Object.keys(TOOL_ICONS) as ToolIconName[]

describe('the tool icons', () => {
  it('draws each icon at all three sizes, every one in a group', () => {
    expect(names.length).toBeGreaterThanOrEqual(45)
    const grouped = Object.values(TOOL_ICON_GROUPS).flat()
    expect([...grouped].sort()).toEqual([...names].sort())
    for (const n of names) for (const s of [32, 24, 16] as const) expect(TOOL_ICONS[n][s].length, `${n} ${s}`).toBeGreaterThan(20)
  })

  it('colors only through the set classes, with no fixed colors', () => {
    for (const n of names) {
      for (const s of [32, 24, 16] as const) {
        const m = TOOL_ICONS[n][s]
        expect(m, `${n} ${s}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill="(?!none)/i)
        for (const c of m.matchAll(/class="([^"]+)"/g)) for (const k of c[1]!.split(' ')) expect(CLASSES.has(k), `${n} ${s}: ${k}`).toBe(true)
      }
    }
  })

  it('snaps 16 px to whole pixels', () => {
    for (const n of names) {
      const m = TOOL_ICONS[n][16]
      for (const d of m.matchAll(/ d="([^"]+)"/g)) expect(d[1], n).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/)
    }
  })

  it('draws the size asked for, decorative unless labeled', () => {
    const at24 = renderToStaticMarkup(<ToolIcon name="push" size={24} />)
    expect(at24).toContain('viewBox="0 0 24 24"')
    expect(at24).toContain('aria-hidden="true"')
    expect(at24).toMatch(/class="ti\b/)
    const at16 = renderToStaticMarkup(<ToolIcon name="push" size={16} label="Push and pull" />)
    expect(at16).toContain('aria-label="Push and pull"')
    expect(at16).toContain('viewBox="0 0 16 16"')
  })
})
