// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The ui kit pieces the Slice sidebar uses, in a DOM: a popover takes focus, gives it back, and closes on Escape and
// on a click outside; a split button's halves act on their own.
import { MenuAnchor, Popover, SplitButton } from '@slicerx/ui'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(node: ReturnType<typeof createElement>): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function PlateChip({ closes }: { closes: string[] }) {
  const [open, setOpen] = useState(false)
  return createElement(
    MenuAnchor,
    null,
    createElement('button', { type: 'button', id: 'chip', onClick: () => setOpen(true) }, 'Textured PEI'),
    createElement(Popover, { open, label: 'Plate type', onClose: () => (closes.push('close'), setOpen(false)) }, createElement('button', { type: 'button', id: 'cool' }, 'Cool plate')),
  )
}

describe('popover', () => {
  it('moves focus in on open and back to the trigger on Escape', () => {
    const closes: string[] = []
    const el = mount(createElement(PlateChip, { closes }))
    const chip = el.querySelector<HTMLButtonElement>('#chip')!
    chip.focus()
    act(() => chip.click())
    expect(document.activeElement?.id).toBe('cool')
    expect(el.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Plate type')
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(closes).toEqual(['close'])
    expect(el.querySelector('[role=dialog]')).toBeNull()
    expect(document.activeElement).toBe(chip)
  })

  it('closes on a pointer down outside, not inside', () => {
    const closes: string[] = []
    const el = mount(createElement(PlateChip, { closes }))
    act(() => el.querySelector<HTMLButtonElement>('#chip')!.click())
    act(() => void el.querySelector('#cool')!.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(closes).toEqual([])
    act(() => void document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(closes).toEqual(['close'])
  })
})

describe('split button', () => {
  it('runs the main action and opens the menu from separate buttons', () => {
    const calls: string[] = []
    const el = mount(createElement(SplitButton, { menuLabel: 'More ways to print', menuOpen: false, onMenu: () => calls.push('menu'), onClick: () => calls.push('print') }, 'Print'))
    const [main, menu] = Array.from(el.querySelectorAll('button'))
    act(() => main!.click())
    act(() => menu!.click())
    expect(calls).toEqual(['print', 'menu'])
    expect(menu!.getAttribute('aria-label')).toBe('More ways to print')
  })

  it('does nothing when the main half is disabled with a reason, yet stays focusable', () => {
    const calls: string[] = []
    const el = mount(createElement(SplitButton, { menuLabel: 'More', menuOpen: false, onMenu: () => calls.push('menu'), onClick: () => calls.push('print'), disabled: true, tip: { title: 'Print', reason: 'Add a model to the plate.' } }, 'Print'))
    const main = el.querySelector('button')!
    expect(main.disabled).toBe(false)
    act(() => main.click())
    expect(calls).toEqual([])
  })
})
