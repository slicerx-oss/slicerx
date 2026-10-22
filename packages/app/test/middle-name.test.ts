// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MiddleName } from '../src/lib/short-name'

const NAME = 'Workshop enclosure printer, bay 12 A'

/** A DOM with no layout: the start's box is `room` px wide and its text 10 px a letter. */
function layout(room: number): void {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('mid-head') ? room : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('mid-head') ? (this.textContent ?? '').length * 10 : 0
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ font: '', measureText: (s: string) => ({ width: s.length * 10 }) })) as never)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
}

beforeEach(() => layout(100))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('MiddleName', () => {
  it('leaves the whole name to CSS unless it is asked to measure', () => {
    const { container } = render(createElement(MiddleName, { name: NAME }))
    expect(container.textContent).toBe(NAME)
  })

  it('with exact, ends the start in an ellipsis that touches the end, and marks the cut', async () => {
    const { container } = render(createElement(MiddleName, { name: NAME, exact: true }))
    await act(async () => {})
    // 100 px of room at 10 px a letter: seven letters and the ellipsis
    expect(container.textContent).toBe('Workshop…, bay 12 A'.replace('Workshop', 'Workshop'.slice(0, 8)))
    expect(container.querySelector('.mid-head')?.hasAttribute('data-cut')).toBe(true)
    expect(container.querySelector('.mid-tail')?.textContent).toBe(', bay 12 A')
  })

  it('with exact, shows the whole name when it fits', async () => {
    vi.restoreAllMocks()
    layout(1000)
    const { container } = render(createElement(MiddleName, { name: NAME, exact: true }))
    await act(async () => {})
    expect(container.textContent).toBe(NAME)
    expect(container.querySelector('[data-cut]')).toBeNull()
  })
})
