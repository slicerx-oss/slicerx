// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Settings rows on a phone are laid out by group: the group stays inline unless one label, beside its control, needs
// more than two lines or has a word that does not fit; then the whole group stacks. Desktop groups carry no mark.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Seg } from '../src/components/seg'
import { groupStacks, labelFit, layOutGroup, SETROWS_ATTR, SettingRow } from '../src/components/setting-row'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Each text node a label holds lays out on as many lines as its data-lines says (jsdom has no layout). */
function fakeLines(): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value(this: Range) {
      const host = this.startContainer.parentElement
      const n = Number(host?.closest('[data-lines]')?.getAttribute('data-lines') ?? 1)
      return Array.from({ length: n }, (_, i) => ({ top: i * 18, width: 40 })) as unknown as DOMRectList
    },
  })
}

function group(lines: number[], { bare = false } = {}): HTMLElement {
  const g = document.createElement('ul')
  for (const n of lines) {
    const row = document.createElement('li')
    row.className = 'sx-setrow'
    if (bare) row.setAttribute('data-bare', '')
    else row.append(document.createElement('span'))
    const label = document.createElement('label')
    label.setAttribute('data-lines', String(n))
    label.textContent = 'A setting'
    row.append(label, document.createElement('input'))
    g.append(row)
  }
  document.body.append(g)
  return g
}

beforeAll(() => {
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
})

afterEach(() => {
  delete (Range.prototype as { getClientRects?: unknown }).getClientRects
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-phone')
})

describe('the group decision', () => {
  it('keeps a group inline while every label takes two lines or fewer and fits its words', () => {
    expect(groupStacks([{ lines: 1, overflow: false }, { lines: 2, overflow: false }])).toBe(false)
    expect(groupStacks([])).toBe(false)
  })

  it('stacks the whole group for one label of three lines, or one word past its column', () => {
    expect(groupStacks([{ lines: 1, overflow: false }, { lines: 3, overflow: false }])).toBe(true)
    expect(groupStacks([{ lines: 1, overflow: true }, { lines: 1, overflow: false }])).toBe(true)
  })
})

describe('a label\'s lines', () => {
  it('counts the label\'s own text and leaves out a block hint under it', () => {
    fakeLines()
    const label = document.createElement('label')
    label.innerHTML = '<span data-lines="2">Free camera</span><small style="display:block" data-lines="3">Orbit around the point</small>'
    document.body.append(label)
    expect(labelFit(label)).toEqual({ lines: 2, overflow: false })
  })
})

describe('laying out a group', () => {
  it('marks nothing on a desktop', () => {
    fakeLines()
    const g = group([3, 1])
    layOutGroup(g)
    expect(g.hasAttribute(SETROWS_ATTR)).toBe(false)
  })

  it('on a phone, stacks a group with one cramped row and keeps one without inline, rails or not', () => {
    fakeLines()
    document.documentElement.setAttribute('data-phone', '')
    const cramped = group([1, 3, 2])
    const fits = group([1, 2, 2], { bare: true })
    layOutGroup(cramped)
    layOutGroup(fits)
    expect(cramped.getAttribute(SETROWS_ATTR)).toBe('stack')
    expect(fits.getAttribute(SETROWS_ATTR)).toBe('inline')
  })

  it('measures inline each time, so a stacked group whose labels now fit goes back inline', () => {
    fakeLines()
    document.documentElement.setAttribute('data-phone', '')
    const g = group([3])
    layOutGroup(g)
    expect(g.getAttribute(SETROWS_ATTR)).toBe('stack')
    g.querySelector('label')!.setAttribute('data-lines', '1')
    layOutGroup(g)
    expect(g.getAttribute(SETROWS_ATTR)).toBe('inline')
  })
})

describe('SettingRow in a list', () => {
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
  })

  it('marks its parent as one group before the first paint, and leaves rows of a full-width control out of the count', async () => {
    fakeLines()
    document.documentElement.setAttribute('data-phone', '')
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ul>
          <SettingRow as="li" label={<label data-lines="1">Fan kickstart</label>} control={<input />} />
          <SettingRow as="li" stack label={<label data-lines="4">Machine start template</label>} control={<textarea />} />
        </ul>,
      )
      await Promise.resolve()
    })
    expect(host.querySelector('ul')!.getAttribute(SETROWS_ATTR)).toBe('inline')
  })

  it('counts a segmented row in the group, so a cramped row beside it stacks them both', async () => {
    fakeLines()
    document.documentElement.setAttribute('data-phone', '')
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const seg = <Seg label="Wipe" size="sm" full value="off" onChange={() => undefined} options={[{ value: 'off', label: 'Off' }, { value: 'part', label: 'Part' }]} />
    await act(async () => {
      root!.render(
        <>
          <ul id="cramped">
            <SettingRow as="li" label={<label data-lines="3">Retraction length when the active extruder changes</label>} control={<input />} />
            <SettingRow as="li" label={<label data-lines="1">Wipe</label>} control={seg} />
          </ul>
          <ul id="seg-cramped">
            <SettingRow as="li" label={<label data-lines="1">Retraction length</label>} control={<input />} />
            <SettingRow as="li" label={<label data-lines="3">Wipe while retracting before a tool change</label>} control={seg} />
          </ul>
        </>,
      )
      await Promise.resolve()
    })
    expect(host.querySelector('#cramped')!.getAttribute(SETROWS_ATTR)).toBe('stack')
    expect(host.querySelector('#seg-cramped')!.getAttribute(SETROWS_ATTR)).toBe('stack')
  })
})
