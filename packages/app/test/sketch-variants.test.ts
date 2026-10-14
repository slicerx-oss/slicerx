// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch picker's second row: the ways to draw a family as a segmented control, and for a family with one way to
// draw it, an empty row, since the Drawing header (or the phone sheet's summary) names the tool.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAMILIES, familyName, familyOf, SketchVariants, VARIANTS } from '../src/cad/sketch-variants'
import type { DrawTool } from '../src/cad/sketch-model'

const roots: Root[] = []

afterEach(() => {
  for (const r of roots.splice(0)) flushSync(() => r.unmount())
  document.body.innerHTML = ''
})

function row(tool: DrawTool, onPick = vi.fn(), reserve = true): HTMLElement {
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  roots.push(root)
  flushSync(() => root.render(createElement(SketchVariants, { tool, onPick, sides: '6', onSides: () => {}, reserve })))
  return box.querySelector('.sketch-variants') ?? box
}

describe('sketch variant row', () => {
  it('shows the ways to draw a family as radios', () => {
    const el = row('rect3')
    const group = el.querySelector('[role="radiogroup"][aria-label="Draw it by"]')!
    expect([...group.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['2-point', '3-point', 'Center'])
    expect(group.querySelector('[aria-checked="true"]')!.textContent).toBe('3-point')
    expect(el.querySelector('[data-testid="sketch-variant-one"]')).toBeNull()
  })

  it('leaves the row empty for every family without variants: no box that looks like a field, nothing to press', () => {
    const single = FAMILIES.map((f) => f.value).filter((f) => !VARIANTS[f])
    expect(single).toEqual(['select', 'line', 'dimension'])
    for (const f of single) {
      const el = row(f as DrawTool)
      expect(el.querySelector('[data-testid="sketch-variant-one"]')).toBeNull()
      expect(el.childElementCount).toBe(0)
    }
    expect(familyName('line')).toBe('Line')
  })

  it('has no row at all in the panel for a family with one way, and shows it for one with ways', () => {
    for (const f of ['select', 'line', 'dimension'] as DrawTool[]) {
      const box = row(f, vi.fn(), false)
      expect(box.querySelector('.sketch-variants')).toBeNull()
      expect(box.childElementCount).toBe(0)
    }
    expect(row('circle', vi.fn(), false).querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(row('arc', vi.fn(), false).querySelector('[role="radiogroup"]')).not.toBeNull()
  })

  it('keeps each variant in its family and the polygon sides beside its ways', () => {
    for (const [f, ways] of Object.entries(VARIANTS)) for (const w of ways!) expect(familyOf(w.value)).toBe(f)
    expect(row('polygonEdge').querySelector('#sk-sides')).not.toBeNull()
    expect(row('line').querySelector('#sk-sides')).toBeNull()
  })
})
