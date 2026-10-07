// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Design's tree lists each object with its history steps, a sketch as a sub-row under its extrude, and its parts.
// Each step shows its tool's icon. Design keeps its own pane state apart from Slice.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { Step, StepParams } from '../src/cad/history/model'
import { stepIcon, stepSketch } from '../src/cad/history/step-icon'
import { HostContext } from '../src/host'
import { railKey } from '../src/state/model-mode'
import { set, type PlateEntry } from '../src/state/store'
import { HistoryTree } from '../src/workspaces/design/history-tree'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const step = (id: string, params: unknown): Step => ({ id, part: -1, transform: I, params: params as StepParams })
const STEPS = [
  step('a', { op: 'shape.extrude', shape: { type: 'sketch', loops: [[], []] }, spec: { distanceMm: 30, operation: 'new' } }),
  step('b', { op: 'shell', open: [{}], wallMm: 2 }),
  step('c', { op: 'edge.fillet', edges: [{}, {}], radiusMm: 5 }),
]

function entry(id: string, name: string, steps?: Step[]): PlateEntry {
  return {
    id,
    name,
    parts: [],
    colors: [],
    handle: { parts: [{ name: 'Body' }], triangles: 12, bboxMm: [10, 10, 10] },
    ...(steps ? { history: { version: 1, base: [], steps } } : {}),
  } as unknown as PlateEntry
}

afterEach(() => {
  document.body.innerHTML = ''
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null })
})

describe('step icons', () => {
  it('follow the tool that made the step', () => {
    expect(STEPS.map((s) => stepIcon(s.params))).toEqual(['ruler', 'shell-open', 'fillet-edge'])
    expect(stepIcon({ op: 'face.push', at: [0, 0, 0], normal: [0, 0, 1], distanceMm: 2 })).toBe('push-pull')
    expect(stepIcon({ op: 'simplify', targetRatio: 0.5 })).toBe('simplify-mesh')
  })

  it('find the sketch a step was drawn from', () => {
    expect(stepSketch(STEPS[0]!.params)).toEqual({ loops: 2 })
    expect(stepSketch(STEPS[1]!.params)).toBeNull()
  })
})

describe('pane memory', () => {
  it('keeps Design apart from Slice and the other tabs', () => {
    expect(railKey('prepare', 'design')).toBe('prepare-design')
    expect(railKey('prepare', 'slice')).toBe('prepare')
    expect(railKey('preview', 'design')).toBe('preview')
  })
})

describe('the Design tree', () => {
  function render(): HTMLElement {
    const el = document.createElement('div')
    document.body.appendChild(el)
    flushSync(() => createRoot(el).render(createElement(HostContext.Provider, { value: {} as Host }, createElement(HistoryTree))))
    return el
  }

  it('opens the selected object with its steps, the sketch under its extrude, then its parts', () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS), entry('o2', 'Ball')], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const objects = [...el.querySelectorAll('.dtree-obj')]
    expect(objects.map((o) => o.querySelector('.dtree-name')?.textContent)).toEqual(['Pi enclosure', 'Ball'])
    expect(objects.map((o) => o.querySelector('.dtree-count')?.textContent)).toEqual(['3', 'mesh'])
    expect([...objects[0]!.querySelectorAll('.cad-step-name')].map((b) => b.textContent)).toEqual(['Sketch extrude 30 mm', 'Shell, 2 mm walls, 1 open face', 'Fillet 5 mm, 2 edges'])
    expect(objects[0]!.querySelectorAll('[data-testid="step-sketch"]')).toHaveLength(1)
    expect(objects[0]!.querySelector('.dtree-parts')?.textContent).toContain('Body')
    // The other object stays closed until it is opened or selected.
    expect(objects[1]!.querySelector('.dtree-body')).toBeNull()
  })

  it('keeps an object whose first step is being edited, while it is off the plate', () => {
    const original = entry('o1', 'Pi enclosure', STEPS)
    set({ plate: [], historyEdit: { objectId: 'o1', index: 0, original } as never })
    const el = render()
    expect(el.querySelector('.dtree-name')?.textContent).toBe('Pi enclosure')
  })
})
