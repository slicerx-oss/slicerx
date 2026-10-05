// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle } from '@slicerx/contracts'
import { applyPreset, clearPreset, LOOK_IDS, resolvePreset } from '@slicerx/ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHistory, type History } from '../src/plate/history'
import { setTool, toolStore } from '../src/plate/tools'
import { decompose, identity } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { ObjectTransform } from '../src/workspaces/prepare/object-transform'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

/** A 20 x 10 x 5 mm box on the bed at the origin. */
function entry(id: string): PlateEntry {
  const p: number[] = []
  for (const x of [-10, 10]) for (const y of [-5, 5]) for (const z of [0, 5]) p.push(x, y, z)
  const handle = { id, hash: id, name: id, triangles: 12, bboxMm: [20, 10, 5], openEdges: 0, parts: [] } as MeshHandle
  return { id, name: id, handle, parts: [{ name: 'p', slot: 1, positions: new Float32Array(p), indices: new Uint32Array() }], colors: ['#bd93f9'], transform: identity() }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const posX = () => decompose(get().plate[0]!.transform).position[0]

function pointer(el: Element, type: string, clientX: number, mods: { shiftKey?: boolean; altKey?: boolean } = {}) {
  const Ctor = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent
  flushSync(() => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, clientX, ...mods, ...({ pointerId: 1 } as object) })))
}

function key(el: EventTarget, k: string, mods: { shiftKey?: boolean; altKey?: boolean } = {}) {
  flushSync(() => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })))
}

describe('transform fields', () => {
  let el: HTMLDivElement
  let root: Root
  let h: History
  beforeEach(() => {
    set({ plate: [entry('a')], selection: 'a' })
    setTool('scale')
    h = createHistory()
    el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    flushSync(() => root.render(createElement(ObjectTransform)))
  })
  afterEach(() => {
    root.unmount()
    el.remove()
    h.dispose()
    toolStore.setState({ tool: 'move', rotateSpace: 'world' })
  })

  const handle = (group: string, axis: string) => el.querySelector(`[role="group"][aria-label="${group}"] .sx-scrub-handle[data-axis="${axis}"]`)!
  const input = (id: string) => el.querySelector<HTMLInputElement>(`#${id}`)!

  it('labels each segment for screen readers and hides the handles', () => {
    for (const [group, id, spoken] of [['Position', 'tf-position', 'millimeters'], ['Scale', 'tf-scale', 'percent'], ['Size', 'tf-size', 'millimeters']] as const) {
      const g = el.querySelector(`[role="group"][aria-label="${group}"]`)!
      expect(g.querySelectorAll('.sx-vector-box')).toHaveLength(1)
      for (const a of ['X', 'Y', 'Z']) expect(input(`${id}-${a.toLowerCase()}`).getAttribute('aria-label')).toBe(`${group} ${a}, ${spoken}`)
      for (const hd of g.querySelectorAll('.sx-scrub-handle')) expect(hd.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('moves the object live while dragging the axis letter, and the release is one undo step', () => {
    const x = handle('Position', 'x')
    pointer(x, 'pointerdown', 100)
    pointer(x, 'pointermove', 104)
    expect(posX()).toBeCloseTo(4)
    pointer(x, 'pointermove', 110)
    expect(posX()).toBeCloseTo(10)
    expect(input('tf-position-x').value).toBe('10')
    // Nothing is in the history until the release.
    expect(h.canUndo()).toBe(false)
    pointer(x, 'pointerup', 110)
    expect(posX()).toBeCloseTo(10)
    expect(h.canUndo()).toBe(true)
    h.undo()
    expect(posX()).toBeCloseTo(0)
    expect(h.canUndo()).toBe(false)
  })

  it('steps 10x with Shift and 0.1x with Alt while dragging', () => {
    const x = handle('Position', 'x')
    pointer(x, 'pointerdown', 0)
    pointer(x, 'pointermove', 3, { shiftKey: true })
    expect(posX()).toBeCloseTo(30)
    pointer(x, 'pointermove', 23, { altKey: true })
    expect(posX()).toBeCloseTo(32)
    pointer(x, 'pointerup', 23)
    expect(input('tf-position-x').value).toBe('32')
  })

  it('puts everything back on Escape, with nothing to undo', () => {
    const x = handle('Position', 'x')
    pointer(x, 'pointerdown', 0)
    pointer(x, 'pointermove', 25)
    expect(posX()).toBeCloseTo(25)
    key(window, 'Escape')
    expect(posX()).toBeCloseTo(0)
    expect(input('tf-position-x').value).toBe('0')
    pointer(x, 'pointerup', 25)
    expect(posX()).toBeCloseTo(0)
    expect(h.canUndo()).toBe(false)
  })

  it('keeps uniform scale and its minimum while dragging', async () => {
    const x = handle('Scale', 'x')
    pointer(x, 'pointerdown', 0)
    pointer(x, 'pointermove', 50)
    pointer(x, 'pointerup', 50)
    await tick()
    flushSync(() => undefined)
    expect(input('tf-scale-x').value).toBe('150')
    expect(input('tf-scale-z').value).toBe('150')
    expect(input('tf-size-y').value).toBe('15')
    // Dragging far below the minimum stops at 0.1%.
    pointer(x, 'pointerdown', 0)
    pointer(x, 'pointermove', -1000, { shiftKey: true })
    pointer(x, 'pointerup', -1000)
    await tick()
    flushSync(() => undefined)
    expect(input('tf-scale-x').value).toBe('0.1')
  })

  it('steps with Up and Down from the keyboard, 10x with Shift, 0.1x with Alt', async () => {
    const f = input('tf-position-x')
    f.focus()
    key(f, 'ArrowUp')
    expect(posX()).toBeCloseTo(1)
    key(f, 'ArrowUp', { shiftKey: true })
    expect(posX()).toBeCloseTo(11)
    await tick()
    key(f, 'ArrowDown', { altKey: true })
    expect(posX()).toBeCloseTo(10.9)
    await tick()
    flushSync(() => undefined)
    expect(f.value).toBe('10.9')
  })

  it('commits a typed value on Enter and refuses one below the minimum', async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    const type = (f: HTMLInputElement, v: string) => {
      flushSync(() => {
        setValue.call(f, v)
        f.dispatchEvent(new Event('input', { bubbles: true }))
      })
      key(f, 'Enter')
    }
    type(input('tf-position-y'), '42')
    expect(decompose(get().plate[0]!.transform).position[1]).toBeCloseTo(42)
    const s = input('tf-size-x')
    type(s, '0')
    await tick()
    flushSync(() => undefined)
    expect(s.value).toBe('20')
    // Escape drops a typed value instead of committing it on the way out.
    const z = input('tf-position-z')
    z.focus()
    flushSync(() => {
      setValue.call(z, '30')
      z.dispatchEvent(new Event('input', { bubbles: true }))
    })
    key(z, 'Escape')
    expect(decompose(get().plate[0]!.transform).position[2]).toBeCloseTo(0)
    expect(z.value).toBe('0')
  })

  for (const id of LOOK_IDS) {
    it(`renders the same fields in the ${id} look`, () => {
      applyPreset(resolvePreset(id))
      try {
        flushSync(() => root.render(createElement(ObjectTransform)))
        expect(document.documentElement.dataset['look']).toBe(id)
        for (const g of ['Position', 'Scale', 'Size']) {
          const group = el.querySelector(`[role="group"][aria-label="${g}"]`)!
          expect(group.classList.contains('sx-vector')).toBe(true)
          expect([...group.querySelectorAll('.sx-scrub-handle')].map((e) => e.textContent)).toEqual(['X', 'Y', 'Z'])
          expect(group.querySelector('.sx-vector-label small')?.textContent).toBe(g === 'Scale' ? '%' : 'mm')
          expect(group.querySelector('.sx-mono')).toBeNull()
        }
      } finally {
        clearPreset()
      }
    })
  }
})
