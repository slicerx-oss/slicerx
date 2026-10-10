// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A held control stops correcting the scroll when the correction cannot help: a control the scroll does not move (a
// modal dialog over the pane), and a layout that never settles, which stops at the cap.
import { keepInPlace, MAX_CORRECTIONS } from '@slicerx/ui'
import { afterEach, describe, expect, it } from 'vitest'

afterEach(() => {
  document.body.innerHTML = ''
})

/** A scrolling box with a control in it; `top` says where the control is on screen for a scroll position. */
function setup(top: (scrollTop: number, reads: number) => number) {
  const box = document.createElement('div')
  box.style.overflowY = 'auto'
  Object.defineProperty(box, 'scrollHeight', { get: () => 100_000 })
  Object.defineProperty(box, 'clientHeight', { get: () => 500 })
  let scrollTop = 0
  let writes = 0
  Object.defineProperty(box, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      writes++
      scrollTop = v
    },
  })
  const el = document.createElement('button')
  el.setAttribute('role', 'tab')
  let reads = 0
  el.getBoundingClientRect = () => ({ top: top(scrollTop, reads++) }) as DOMRect
  box.append(el)
  document.body.append(box)
  return { box, el, writes: () => writes }
}

/** Changes the box's content over and over: each change is one mutation the hold sees. */
async function churn(box: HTMLElement, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    box.append(document.createElement('span'))
    await Promise.resolve()
    await Promise.resolve()
  }
}

describe('a held control', () => {
  it('stops at once when the scroll does not move it, as in a modal dialog drawn over the pane', async () => {
    // Always 40 px lower than when pressed, wherever the box scrolls.
    let first = true
    const t = setup(() => (first ? ((first = false), 100) : 140))
    keepInPlace(t.el, 10_000)
    await churn(t.box, 200)
    expect(t.writes()).toBeLessThanOrEqual(1)
  })

  it('stops after the cap when the layout keeps moving the control', async () => {
    // Every read finds the control further down, and the scroll moves it only half as far: it never settles.
    const t = setup((scrollTop, reads) => 100 + reads * 10 - scrollTop / 2)
    keepInPlace(t.el, 10_000)
    await churn(t.box, MAX_CORRECTIONS * 3)
    expect(t.writes()).toBeGreaterThan(0)
    expect(t.writes()).toBeLessThanOrEqual(MAX_CORRECTIONS)
  })
})
