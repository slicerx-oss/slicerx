// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch picker's second row: the ways to draw a family as a segmented control, and for a family with one way to
// draw it, the family's name as a single picked segment that is text, not a control.
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

function row(tool: DrawTool, onPick = vi.fn()): HTMLElement {
  const box = document.createElement('div')
  document.body.append(box)
  const root = createRoot(box)
  roots.push(root)
  flushSync(() => root.render(createElement(SketchVariants, { tool, onPick, sides: '6', onSides: () => {} })))
  return box.querySelector('.sketch-variants')!
}

describe('sketch variant row', () => {
  it('shows the ways to draw a family as radios', () => {
    const el = row('rect3')
    const group = el.querySelector('[role="radiogroup"][aria-label="Draw it by"]')!
    expect([...group.querySelectorAll('[role="radio"]')].map((b) => b.textContent)).toEqual(['2-point', '3-point', 'Center'])
    expect(group.querySelector('[aria-checked="true"]')!.textContent).toBe('3-point')
    expect(el.querySelector('[data-testid="sketch-variant-one"]')).toBeNull()
  })

  it('names every family without variants in one static segment, with nothing to focus or press', () => {
    const single = FAMILIES.map((f) => f.value).filter((f) => !VARIANTS[f])
    expect(single).toEqual(['select', 'line', 'dimension'])
    for (const f of single) {
      const onPick = vi.fn()
      const el = row(f as DrawTool, onPick)
      const one = el.querySelector('[data-testid="sketch-variant-one"]')!
      expect(one.textContent).toBe(familyName(f))
      expect(one.getAttribute('role')).toBeNull()
      expect(el.querySelectorAll('button, [role="radio"], [role="radiogroup"], [tabindex], input')).toHaveLength(0)
      ;(one.firstElementChild as HTMLElement).click()
      expect(onPick).not.toHaveBeenCalled()
    }
    expect(familyName('line')).toBe('Line')
  })

  it('keeps each variant in its family and the polygon sides beside its ways', () => {
    for (const [f, ways] of Object.entries(VARIANTS)) for (const w of ways!) expect(familyOf(w.value)).toBe(f)
    expect(row('polygonEdge').querySelector('#sk-sides')).not.toBeNull()
    expect(row('line').querySelector('#sk-sides')).toBeNull()
  })
})
