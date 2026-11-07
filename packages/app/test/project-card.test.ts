// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The sketch panel's Project card: a step opened from the history shows its projections and changes none of them,
// since a change there would leave the step and its sketch out of step; a finished or new sketch can switch and
// remove each one.
import type { FaceFrame, Projection, SketchLoop } from '@slicerx/cad-history'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectCard, type Projected } from '../src/cad/project-card'
import { set } from '../src/state/store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const BED: FaceFrame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const square: SketchLoop = { start: [0, 0], segments: [{ type: 'line', to: [4, 0] }, { type: 'line', to: [4, 4] }, { type: 'line', to: [0, 4] }, { type: 'line', to: [0, 0] }] }
const p1: Projection = { id: 'p1', source: { kind: 'face', body: 'b', part: 0, transform: I, face: { at: [1, 1, 5], normal: [0, 0, 1] } }, mode: 'real' }
const value: Projected = { list: [p1], loops: [{ ...square, projected: 'p1' }], next: 1 }

let root: Root | null = null
let el: HTMLElement | null = null
const changes: Projected[] = []
function mount(locked: boolean): HTMLElement {
  set({ plate: [] })
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  act(() => root!.render(createElement(ProjectCard, { frame: BED, value, onChange: (v: Projected) => changes.push(v), locked })))
  return el
}
afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  root = null
  changes.length = 0
})

describe('the Project card', () => {
  it('shows a step’s projections read only', () => {
    const card = mount(true)
    const row = card.querySelector('[data-testid="sketch-projection-p1"]')!
    expect(row.textContent).toContain('Real')
    expect(row.querySelector('[data-testid="sketch-projection-p1-remove"]')).toBeNull()
    expect(row.querySelectorAll('[role="radio"]')).toHaveLength(0)
    expect(card.querySelector('[data-testid="sketch-project-face"]')).toBeNull()
  })

  it('switches and removes a finished sketch’s projections', () => {
    const card = mount(false)
    const row = card.querySelector('[data-testid="sketch-projection-p1"]')!
    const reference = [...row.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => r.textContent === 'Reference')!
    act(() => reference.click())
    expect(changes.at(-1)!.list[0]!.mode).toBe('reference')
    act(() => row.querySelector<HTMLElement>('[data-testid="sketch-projection-p1-remove"]')!.click())
    // the removed id stays counted
    expect(changes.at(-1)).toEqual({ list: [], loops: [], next: 1 })
  })
})
