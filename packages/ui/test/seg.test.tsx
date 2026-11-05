// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The segmented control: the arrow keys move the choice and the focus together, and a row too wide for its box is
// marked so it scrolls and fades at each edge with options past it.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Seg } from '../src/components/seg'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TABS = [
  { value: 'basic', label: 'Basic information' },
  { value: 'extruder', label: 'Extruder and retraction' },
  { value: 'motion', label: 'Motion ability' },
  { value: 'multi', label: 'Multimaterial' },
  { value: 'cooling', label: 'Cooling' },
]

function Tabs() {
  const [v, setV] = useState('basic')
  return <Seg label="Printer settings tab" size="sm" value={v} onChange={setV} options={TABS} />
}

describe('Seg', () => {
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
  })

  const radio = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === name)!
  const key = (k: string) => act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))

  it('moves the choice and the focus with the arrow keys, round from the last option to the first', () => {
    act(() => root.render(<Tabs />))
    radio('Basic information').focus()
    key('ArrowLeft')
    expect(radio('Cooling').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(radio('Cooling'))
    expect(radio('Cooling').tabIndex).toBe(0)
    key('ArrowRight')
    expect(radio('Basic information').getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(radio('Basic information'))
  })

  it('marks a row wider than its box, and each edge with options past it', () => {
    act(() => root.render(<Tabs />))
    const row = host.querySelector<HTMLElement>('[role="radiogroup"]')!
    expect(row.hasAttribute('data-overflow')).toBe(false)
    let left = 0
    Object.defineProperties(row, {
      scrollWidth: { configurable: true, get: () => 482 },
      clientWidth: { configurable: true, get: () => 330 },
      scrollLeft: { configurable: true, get: () => left, set: (v: number) => void (left = v) },
    })
    act(() => void row.dispatchEvent(new Event('scroll')))
    expect(row.hasAttribute('data-overflow')).toBe(true)
    expect(row.hasAttribute('data-more-start')).toBe(false)
    expect(row.hasAttribute('data-more-end')).toBe(true)
    left = 152
    act(() => void row.dispatchEvent(new Event('scroll')))
    expect(row.hasAttribute('data-more-start')).toBe(true)
    expect(row.hasAttribute('data-more-end')).toBe(false)
  })
})
