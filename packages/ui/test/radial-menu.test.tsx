// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The ring menu: slots clockwise from the top round a middle that opens More, kept inside the window; the keys go
// round, Enter runs, Escape closes; a click or a flick runs what it lands on, and a verb that is off never runs.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RadialMenu, RING_HOLE, RING_R, ringCenter, slotAt, type RingItem } from '../src/components/radial-menu'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ring geometry', () => {
  it('finds the slot under a point, clockwise from the top, the middle, or nothing outside', () => {
    expect(slotAt(0, -60, 6)).toBe(0)
    expect(slotAt(60, 0, 6)).toBe(2)
    expect(slotAt(0, 60, 6)).toBe(3)
    expect(slotAt(-60, 0, 6)).toBe(5)
    expect(slotAt(0, -60, 4)).toBe(0)
    expect(slotAt(60, 0, 4)).toBe(1)
    expect(slotAt(0, 0, 6)).toBe(-1)
    expect(slotAt(RING_HOLE - 1, 0, 6)).toBe(-1)
    expect(slotAt(RING_R + 20, 0, 6)).toBeNull()
  })

  it('keeps the whole ring inside the window', () => {
    expect(ringCenter({ x: 500, y: 400 }, { width: 1000, height: 800 })).toEqual({ x: 500, y: 400 })
    const c = ringCenter({ x: 5, y: 795 }, { width: 1000, height: 800 })
    expect(c.x).toBe(RING_R + 8)
    expect(c.y).toBe(800 - RING_R - 8)
  })
})

describe('RadialMenu', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    document.body.innerHTML = ''
  })

  const items = (runs: Record<string, () => void>): RingItem[] => [
    { id: 'a', label: 'Fillet', icon: 'fillet-edge', run: runs['a'] ?? (() => undefined) },
    { id: 'b', label: 'Chamfer', icon: 'chamfer-edge', disabled: true, reason: 'Not here', run: runs['b'] ?? (() => undefined) },
    { id: 'c', label: 'Measure', icon: 'measure', run: runs['c'] ?? (() => undefined) },
  ]
  const show = (props: Partial<Parameters<typeof RadialMenu>[0]> & { items: RingItem[] }) =>
    act(() => root.render(<RadialMenu at={{ x: 400, y: 300 }} onClose={props.onClose ?? (() => undefined)} label="Edge" testId="ring" {...props} />))

  it('lists the verbs as menu items with the first that runs focused, and a More in the middle', () => {
    show({ items: items({}) })
    const ring = document.querySelector('[data-testid="ring"]')!
    expect(ring.getAttribute('role')).toBe('menu')
    const slots = [...ring.querySelectorAll('.sx-ring-slot')]
    expect(slots.map((s) => s.textContent)).toEqual(['Fillet', 'Chamfer', 'Measure'])
    expect(slots[1]!.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(slots[0])
    expect(ring.querySelector('[data-testid="ring-more"]')?.getAttribute('aria-label')).toBe('More for Edge')
  })

  it('goes round with the arrows, runs with Enter and closes with Escape', () => {
    const a = vi.fn()
    const c = vi.fn()
    const onClose = vi.fn()
    show({ items: items({ a, c }), onClose })
    const ring = document.querySelector<HTMLElement>('[data-testid="ring"]')!
    const key = (k: string, shift = false) => act(() => void ring.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true })))
    key('ArrowRight')
    key('ArrowRight')
    expect((document.activeElement as HTMLElement).textContent).toBe('Measure')
    key('Enter')
    expect(c).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(a).not.toHaveBeenCalled()
  })

  it('a verb that is off does nothing, and the middle opens More', () => {
    const b = vi.fn()
    const more = vi.fn()
    show({ items: items({ b }), onMore: more })
    const ring = document.querySelector<HTMLElement>('[data-testid="ring"]')!
    const key = (k: string) => act(() => void ring.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
    key('ArrowRight')
    key('Enter')
    expect(b).not.toHaveBeenCalled()
    key('ArrowRight')
    key('ArrowRight')
    expect((document.activeElement as HTMLElement).dataset['slot']).toBe('more')
    key('Enter')
    expect(more).toHaveBeenCalledTimes(1)
  })
})
