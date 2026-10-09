// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Design's tree lists each object with its history steps, a sketch as a sub-row under its extrude, and its parts.
// Each step shows its tool's icon. Design keeps its own pane state apart from Slice.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { Host } from '@slicerx/contracts'
import type { Step, StepParams } from '../src/cad/history/model'
import { stepIcon, stepSketch } from '../src/cad/history/step-icon'
import { HostContext } from '../src/host'
import { railKey } from '../src/state/model-mode'
import { renameStep } from '../src/cad/history/ops'
import { get, set, type PlateEntry } from '../src/state/store'
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

// Roots unmount before the page is cleared, so an open menu's portal is not pulled out from under React.
const roots: Root[] = []
afterEach(() => {
  for (const r of roots.splice(0)) flushSync(() => r.unmount())
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
    const root = createRoot(el)
    roots.push(root)
    flushSync(() => root.render(createElement(HostContext.Provider, { value: {} as Host }, createElement(HistoryTree))))
    return el
  }

  it('opens the selected object with its steps, the sketch under its extrude, then its parts', () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS), entry('o2', 'Ball')], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const objects = [...el.querySelectorAll('.dtree-obj')]
    expect(objects.map((o) => o.querySelector('.dtree-name')?.textContent)).toEqual(['Pi enclosure', 'Ball'])
    // A CAD object shows its step count; a mesh shows nothing there, its icon says it.
    expect(objects.map((o) => o.querySelector('.dtree-count')?.textContent ?? null)).toEqual(['3', null])
    expect(objects.map((o) => o.getAttribute('data-kind'))).toEqual(['body', 'mesh'])
    expect([...objects[0]!.querySelectorAll('.cad-step-name')].map((b) => b.textContent)).toEqual(['Sketch extrude 30 mm', 'Shell, 2 mm walls, 1 open face', 'Fillet 5 mm, 2 edges'])
    expect(objects[0]!.querySelectorAll('[data-testid="step-sketch"]')).toHaveLength(1)
    expect(objects[0]!.querySelector('.dtree-parts')?.textContent).toContain('Body')
    // The other object stays closed until it is opened or selected.
    expect(objects[1]!.querySelector('.dtree-body')).toBeNull()
  })

  it("puts a step's tips beside its row, so a tip never covers the step under it", () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS)], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const tips = [...el.querySelectorAll('.cad-step')].flatMap((row) => [...row.querySelectorAll('[data-tip], [data-tip-title]')])
    expect(tips.length).toBe(STEPS.length * 3)
    expect(tips.every((b) => b.getAttribute('data-tip-avoid') === '.cad-step')).toBe(true)
  })

  it('keeps step rows calm: no buttons at rest but one More, which opens the step menu', () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS)], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const row = el.querySelector('[data-testid="model-tree-step"]')!
    expect(row.getAttribute('data-object-id')).toBe('o1')
    expect(row.getAttribute('data-index')).toBe('0')
    expect(row.querySelectorAll('.sx-btn')).toHaveLength(0)
    const more = row.querySelector<HTMLButtonElement>('[data-testid="model-tree-more"]')!
    expect(more.getAttribute('aria-label')).toBe('More for Sketch extrude 30 mm')
    flushSync(() => more.click())
    const menu = document.querySelector('[data-testid="model-ctx"]')!
    expect(menu.getAttribute('data-target')).toBe('step')
    expect([...menu.querySelectorAll('.sx-menu-icon')].map((b) => b.getAttribute('aria-label'))).toEqual(['Edit', 'Roll to here', 'Turn off', 'Delete'])
    expect([...menu.querySelectorAll('.sx-menu-item:not(.sx-menu-icon)')].map((b) => b.textContent?.replace(/[⌥↑↓]|Alt\+(Up|Down)|F2/g, '').trim())).toEqual(['Rename', 'Move earlier', 'Move later', 'Select its faces', 'Show the sketch'])
  })

  it('renames a step from F2, and gives it its own name back when cleared', () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS)], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const row = el.querySelector<HTMLElement>('[data-testid="model-tree-step"]')!
    flushSync(() => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true })))
    const field = el.querySelector<HTMLInputElement>('[data-testid="model-tree-rename"]')!
    expect(field.value).toBe('Sketch extrude 30 mm')
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Base plate')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(get().plate[0]!.history!.steps[0]!.label).toBe('Base plate')
    expect(el.querySelector('.cad-step-label')?.textContent).toBe('Base plate')
    renameStep('o1', 0, '')
    expect(get().plate[0]!.history!.steps[0]!.label).toBeUndefined()
  })

  it('refuses to rename the step being edited', () => {
    const original = entry('o1', 'Pi enclosure', STEPS)
    set({ plate: [original], historyEdit: { objectId: 'o1', index: 1, original } as never })
    expect(() => renameStep('o1', 1, 'Walls')).toThrow("That step can't be renamed while it's being edited.")
    renameStep('o1', 0, 'Base')
    expect(get().historyEdit!.original.history!.steps[0]!.label).toBe('Base')
  })

  it("opens an object's menu with Shift+F10, selecting it first", () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS), entry('o2', 'Ball')], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const name = el.querySelectorAll<HTMLElement>('.dtree-name')[1]!
    flushSync(() => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })))
    expect(get().selectedIds).toEqual(['o2'])
    const menu = document.querySelector('[data-testid="model-ctx"][data-target="object"]')!
    expect([...menu.querySelectorAll('.sx-menu-icon')].map((b) => b.getAttribute('aria-label'))).toEqual(['Rename', 'Lock', 'Leave out of the print', 'Delete'])
    expect(menu.querySelector<HTMLButtonElement>('[data-testid="model-ctx-merge"]')!.disabled).toBe(true)
  })

  it('badges a broken step in red and a step with a note in orange, and shows lock and printable off', () => {
    const broken = [{ ...STEPS[0]!, broken: 'The sketch is gone.' }, { ...STEPS[1]!, note: 'Thin wall.' }, STEPS[2]!]
    set({ plate: [{ ...entry('o1', 'Pi enclosure', broken), locked: true, printable: false }], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    expect([...el.querySelectorAll('.cad-step-icon')].map((i) => i.getAttribute('data-badge'))).toEqual(['broken', null, null])
    expect([...el.querySelectorAll('.dtree-state')].map((i) => i.getAttribute('aria-label'))).toEqual(['Locked', 'Not printed'])
  })

  it('is a tree to the keyboard: one row in the tab order, arrows move, Right and Left open and close', () => {
    set({ plate: [entry('o1', 'Pi enclosure', STEPS), entry('o2', 'Ball')], selection: 'o1', selectedIds: ['o1'] })
    const el = render()
    const tree = el.querySelector<HTMLElement>('[role="tree"]')!
    const tabbable = () => [...tree.querySelectorAll<HTMLElement>('[tabindex="0"]')].map((b) => b.textContent)
    expect(tabbable()).toEqual(['Pi enclosure'])
    const press = (key: string) => flushSync(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
    tree.querySelector<HTMLElement>('.dtree-name')!.focus()
    press('ArrowDown')
    expect(document.activeElement?.textContent).toBe('Sketch extrude 30 mm')
    press('ArrowRight')
    expect(document.activeElement?.getAttribute('data-testid')).toBe('model-tree-more')
    press('ArrowLeft')
    press('ArrowLeft')
    expect(document.activeElement?.textContent).toBe('Pi enclosure')
    press('End')
    expect(document.activeElement?.textContent).toBe('Ball')
    press('ArrowRight')
    expect(el.querySelectorAll('.dtree-obj')[1]!.getAttribute('aria-expanded')).toBe('true')
    press('ArrowLeft')
    expect(el.querySelectorAll('.dtree-obj')[1]!.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps an object whose first step is being edited, while it is off the plate', () => {
    const original = entry('o1', 'Pi enclosure', STEPS)
    set({ plate: [], historyEdit: { objectId: 'o1', index: 0, original } as never })
    const el = render()
    expect(el.querySelector('.dtree-name')?.textContent).toBe('Pi enclosure')
  })
})
