// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A dialog that opens under a resting pointer shows no tip for the control it put there, but it never costs a control
// elsewhere its tip: a hover outside the dialog in the moment after it opened (or after it closed again, as a command
// run from the palette does) opens that control's tip as usual.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIP_TIMING, TooltipHost } from '../src/components/tooltip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement

function anchor(title: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.setAttribute('data-tip-title', title)
  return b
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.advanceTimersByTime(1000)
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver
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

/** Opens a dialog (a backdrop wrapping it, as the command palette has) with one control in it. */
async function openDialog(control: HTMLElement): Promise<HTMLElement> {
  const wrap = document.createElement('div')
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.append(control)
  wrap.append(dialog)
  document.body.append(wrap)
  await settle()
  return wrap
}

describe('a dialog that has just opened', () => {
  it('shows no tip for a control it opened under the pointer', async () => {
    const inside = anchor('Run')
    await openDialog(inside)
    hover(inside)
    wait(TIP_TIMING.cold + TIP_TIMING.dialogQuiet)
    expect(tip()).toBeNull()
  })

  it('shows the tip of a control inside it once the pointer moves onto it later', async () => {
    const inside = anchor('Run')
    await openDialog(inside)
    wait(TIP_TIMING.dialogQuiet)
    hover(inside)
    wait(TIP_TIMING.cold)
    expect(tip()?.textContent).toBe('Run')
  })

  it('still shows the tip of a control outside it', async () => {
    const outside = anchor('Layer height')
    document.body.append(outside)
    await openDialog(anchor('Run'))
    hover(outside)
    wait(TIP_TIMING.cold)
    expect(tip()?.textContent).toBe('Layer height')
  })

  it('still shows the tip of a control the pointer reaches right after the dialog closed', async () => {
    const outside = anchor('Layer height')
    document.body.append(outside)
    const wrap = await openDialog(anchor('Start over with the example plate'))
    wait(TIP_TIMING.dialogQuiet / 3)
    wrap.remove()
    await settle()
    hover(outside)
    wait(TIP_TIMING.cold)
    expect(tip()?.textContent).toBe('Layer height')
  })
})
