// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The setting tooltip: a short hover delay, reachable by keyboard focus, beside the row it explains,
// described for screen readers, and still under reduced motion.
import { setMotionPreference, TIP_TIMING, TooltipHost } from '@slicerx/ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSettingTips, resolveTip } from '../src/lib/tip-host'
import { settingTipAttrs } from '../src/lib/tips'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROW = { left: 700, top: 300, width: 300, height: 32 }
const TIP = { width: 248, height: 150 }

function rect(r: { left: number; top: number; width: number; height: number }): DOMRect {
  return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect
}

let root: Root
let host: HTMLDivElement
let row: HTMLLIElement
let input: HTMLInputElement
let reduce = false

// the app fetches setting tips once it is up; the tests start after that
beforeAll(async () => {
  await loadSettingTips()
})

beforeEach(() => {
  vi.useFakeTimers()
  // The host ignores hovers in the first moments after a dialog opens; start the fake clock past that.
  vi.advanceTimersByTime(1000)
  reduce = false
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  setMotionPreference('system')
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.id === 'sx-tip') return rect({ left: 0, top: 0, ...TIP })
    if (this.closest('.field')) return rect(ROW)
    return rect({ left: 0, top: 0, width: 0, height: 0 })
  })
  row = document.createElement('li')
  row.className = 'field'
  for (const [k, v] of Object.entries(settingTipAttrs('wall_loops'))) row.setAttribute(k, v)
  row.innerHTML = '<label for="set-wall_loops">Wall loops</label><input id="set-wall_loops">'
  input = row.querySelector('input') as HTMLInputElement
  document.body.append(row)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TooltipHost, { resolve: (el: HTMLElement) => resolveTip(el, {}) })))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  row.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const tip = () => document.getElementById('sx-tip')
const hover = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

describe('setting tooltip', () => {
  it('appears after a short hover delay with the note and the figure', () => {
    hover(row.querySelector('label') as Element)
    wait(TIP_TIMING.cold - 100)
    expect(tip()).toBeNull()
    wait(100)
    expect(tip()?.querySelector('.sx-tip-title')?.textContent).toBe('Wall loops')
    expect(tip()?.querySelector('.sx-tip-body')?.textContent).toMatch(/loops/)
    expect(tip()?.querySelector('.sx-tip-fig svg.sx-fig')).not.toBeNull()
    expect(tip()?.textContent).not.toContain('wall_loops')
    expect(row.getAttribute('aria-describedby')).toBe('sx-tip')
    expect(tip()?.getAttribute('role')).toBe('tooltip')
  })

  it('hands over to a neighbor after the short warm delay, not the cold one', () => {
    const next = document.createElement('li')
    next.className = 'field'
    for (const [k, v] of Object.entries(settingTipAttrs('top_shell_layers'))) next.setAttribute(k, v)
    document.body.append(next)
    hover(row)
    wait(TIP_TIMING.cold)
    expect(tip()?.hasAttribute('data-warm')).toBe(false)
    act(() => void row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: next })))
    hover(next)
    wait(TIP_TIMING.warm - 1)
    expect(tip()?.querySelector('.sx-tip-title')?.textContent).toBe('Wall loops')
    wait(1)
    expect(tip()?.querySelector('.sx-tip-title')?.textContent).not.toBe('Wall loops')
    expect(tip()?.hasAttribute('data-warm')).toBe(true)
    expect(next.getAttribute('aria-describedby')).toBe('sx-tip')
    next.remove()
  })

  it('sits beside the row and never covers the control', () => {
    hover(input)
    wait(TIP_TIMING.cold)
    const t = tip() as HTMLElement
    const x = parseFloat(t.style.left)
    const y = parseFloat(t.style.top)
    const overlaps = x < ROW.left + ROW.width && x + TIP.width > ROW.left && y < ROW.top + ROW.height && y + TIP.height > ROW.top
    expect(overlaps).toBe(false)
    expect(t.dataset.side).toBe('left')
  })

  it('opens on keyboard focus and describes the focused field', () => {
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? this === input : Element.prototype.closest.call(this, sel) === this
    })
    act(() => input.focus())
    wait(TIP_TIMING.focus)
    expect(tip()).not.toBeNull()
    expect(input.getAttribute('aria-describedby')).toBe('sx-tip')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(tip()).toBeNull()
    expect(input.hasAttribute('aria-describedby')).toBe(false)
  })

  it('does not open when a click focuses the field', () => {
    act(() => void input.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    act(() => input.focus())
    wait(TIP_TIMING.cold)
    expect(tip()).toBeNull()
  })

  it('holds the figure still under reduced motion', () => {
    hover(row)
    wait(TIP_TIMING.cold)
    expect(tip()?.hasAttribute('data-still')).toBe(false)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    // the system asks for reduced motion and Motion follows it
    reduce = true
    setMotionPreference('system')
    wait(TIP_TIMING.warmWindow + 10)
    act(() => void row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    hover(row)
    wait(TIP_TIMING.cold)
    expect(tip()?.hasAttribute('data-still')).toBe(true)
  })
})

describe('tooltips in dialogs and on click', () => {
  const click = (el: Element) => {
    act(() => void el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    act(() => void el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
    act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('renders inside an open dialog, as a popover over its top layer', () => {
    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    const b = document.createElement('button')
    b.setAttribute('data-tip-title', 'Inside')
    dialog.append(b)
    document.body.append(dialog)
    hover(b)
    wait(TIP_TIMING.cold)
    expect(tip()?.parentElement).toBe(dialog)
    expect(tip()?.getAttribute('popover')).toBe('manual')
    // Esc closes the tip, not the dialog under it.
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => void window.dispatchEvent(esc))
    expect(tip()).toBeNull()
    expect(esc.defaultPrevented).toBe(true)
    dialog.remove()
  })

  it('opens on a click when the anchor asks for it, and a second click closes it', () => {
    row.setAttribute('data-tip-click', '')
    click(row)
    expect(tip()?.querySelector('.sx-tip-title')?.textContent).toBe('Wall loops')
    // Lifting a finger or moving the mouse off does not close it.
    act(() => void row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })))
    wait(TIP_TIMING.hide + 10)
    expect(tip()).not.toBeNull()
    click(row)
    expect(tip()).toBeNull()
  })

  it('closes a click-opened tip on a click elsewhere, and leaves plain anchors closed on click', () => {
    row.setAttribute('data-tip-click', '')
    click(row)
    expect(tip()).not.toBeNull()
    click(document.body)
    expect(tip()).toBeNull()
    row.removeAttribute('data-tip-click')
    click(row)
    expect(tip()).toBeNull()
  })
})
