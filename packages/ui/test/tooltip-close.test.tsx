// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip never stays over a field someone types into, or over the place its control left: a text field taking focus
// closes any other control's tip, and a tip closes with its anchor when the anchor is unmounted or swapped by a re-render.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIP_TIMING, TooltipHost } from '../src/components/tooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let chip: HTMLButtonElement
let field: HTMLInputElement

function anchor(title: string, click = false): HTMLButtonElement {
  const b = document.createElement('button')
  b.setAttribute('data-tip-title', title)
  if (click) b.setAttribute('data-tip-click', '')
  return b
}

beforeEach(() => {
  vi.useFakeTimers()
  // the host ignores hovers just after a dialog opens; start the fake clock past that
  vi.advanceTimersByTime(1000)
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
  chip = anchor('A4 is empty')
  field = document.createElement('input')
  field.type = 'text'
  document.body.append(chip, field)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(createElement(TooltipHost, { resolve: (el: HTMLElement) => ({ title: el.getAttribute('data-tip-title') ?? '' }) })))
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
})

const tip = () => document.getElementById('sx-tip')
const hover = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })))
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))
/** Lets the host's mutation observer run. */
const settle = () => act(async () => await Promise.resolve())
const focus = (el: HTMLElement) => act(() => el.focus())

describe('a text field taking focus', () => {
  it('closes a hovered tip, focused from code with nothing focused before', () => {
    hover(chip)
    wait(TIP_TIMING.cold)
    expect(tip()?.textContent).toBe('A4 is empty')
    expect(document.activeElement).toBe(document.body)
    focus(field)
    expect(tip()).toBeNull()
    expect(chip.hasAttribute('aria-describedby')).toBe(false)
  })

  it('closes a tip a click opened, which a focus leaving keeps', () => {
    const pinned = anchor('Mismatch', true)
    document.body.append(pinned)
    act(() => void pinned.click())
    expect(tip()?.textContent).toBe('Mismatch')
    // a button taking focus leaves it open
    focus(chip)
    expect(tip()?.textContent).toBe('Mismatch')
    focus(field)
    expect(tip()).toBeNull()
  })

  it('stops a tip still on its hover delay', () => {
    hover(chip)
    wait(TIP_TIMING.cold - 100)
    focus(field)
    wait(TIP_TIMING.cold)
    expect(tip()).toBeNull()
  })

  it('keeps the tip of the control the field is part of', () => {
    const row = document.createElement('label')
    row.setAttribute('data-tip-title', 'Layer height')
    const own = document.createElement('input')
    row.append(own)
    document.body.append(row)
    hover(row)
    wait(TIP_TIMING.cold)
    focus(own)
    expect(tip()?.textContent).toBe('Layer height')
  })

  it('also closes a tip for a text area, and not for a checkbox', () => {
    const box = document.createElement('input')
    box.type = 'checkbox'
    const area = document.createElement('textarea')
    document.body.append(box, area)
    hover(chip)
    wait(TIP_TIMING.cold)
    focus(box)
    expect(tip()?.textContent).toBe('A4 is empty')
    focus(area)
    expect(tip()).toBeNull()
  })
})

describe('a tip whose anchor goes away', () => {
  it('closes when the anchor is unmounted', async () => {
    hover(chip)
    wait(TIP_TIMING.cold)
    expect(tip()).not.toBeNull()
    chip.remove()
    await settle()
    expect(tip()).toBeNull()
  })

  it('closes when a re-render swaps the anchor for a new element', async () => {
    const pinned = anchor('A4 is empty', true)
    document.body.append(pinned)
    act(() => void pinned.click())
    expect(tip()).not.toBeNull()
    pinned.replaceWith(anchor('A4 is empty', true))
    await settle()
    expect(tip()).toBeNull()
  })

  it('never opens for an anchor that left while its delay ran', async () => {
    hover(chip)
    wait(TIP_TIMING.cold - 100)
    chip.remove()
    await settle()
    wait(TIP_TIMING.cold)
    expect(tip()).toBeNull()
  })

  it('stays while the anchor moves within the page', async () => {
    hover(chip)
    wait(TIP_TIMING.cold)
    document.body.prepend(chip)
    await settle()
    expect(tip()?.textContent).toBe('A4 is empty')
  })
})
