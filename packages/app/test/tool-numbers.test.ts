// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tool's number fields read named values: an X, Y row takes `wall * 2` as it does a plain number, and a single
// field shows its unit once, beside the label, in the body font.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Num, Vec } from '../src/cad/panel-kit'
import { set } from '../src/state/store'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const r of roots.splice(0)) flushSync(() => r.unmount())
  document.body.innerHTML = ''
  set({ namedValues: [] })
})

function render(node: ReturnType<typeof createElement>): HTMLElement {
  const el = document.body.appendChild(document.createElement('div'))
  const root = createRoot(el)
  roots.push(root)
  flushSync(() => root.render(node))
  return el
}

/** Types into a React field the way a person does, then presses Enter. */
function type(input: HTMLInputElement, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
  flushSync(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
}

describe('tool number fields', () => {
  it('an X, Y row takes an expression over named values', () => {
    set({ namedValues: [{ name: 'wall', expr: '3' }] })
    const setX = vi.fn()
    const setY = vi.fn()
    const el = render(createElement(Vec, { id: 'arr-c', label: 'Center', unit: 'mm', axes: ['x', 'y'], values: ['0', '0'], onChange: [setX, setY] }))
    type(el.querySelector<HTMLInputElement>('#arr-c-x')!, 'wall * 2')
    expect(setX).toHaveBeenLastCalledWith('6')
    type(el.querySelector<HTMLInputElement>('#arr-c-y')!, 'nope + 1')
    expect(setY).not.toHaveBeenCalled()
  })

  it('a single field shows its unit once, beside the label, in the body font', () => {
    const el = render(createElement(Num, { id: 'push-dist', label: 'Distance', unit: 'mm', value: '5', onChange: () => undefined }))
    expect(el.querySelector('label')?.textContent).toBe('Distance mm')
    const input = el.querySelector<HTMLInputElement>('#push-dist')!
    expect(input.dataset['mono']).toBeUndefined()
    expect(input.classList.contains('cad-num')).toBe(true)
  })
})
