// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A tip shows for focus the keyboard moved, never for focus handed back when a popover or menu closes.
import { describe, expect, it } from 'vitest'
import { focusIntent } from '../src/components/tooltip'

function make() {
  let t = 1000
  const f = focusIntent(() => t)
  return { f, tick: (ms: number) => (t += ms) }
}

describe('the tooltip focus rule', () => {
  it('shows a tip for focus that Tab moved', () => {
    const { f } = make()
    f.key('Tab')
    expect(f.focus()).toBe(true)
  })
  it('shows a tip for focus that an arrow key moved in a roving toolbar', () => {
    const { f } = make()
    f.key('ArrowRight')
    expect(f.focus()).toBe(true)
  })
  it('ignores focus returned after Escape, Enter or Space closed a popover', () => {
    for (const k of ['Escape', 'Enter', ' ']) {
      const { f } = make()
      f.key(k)
      expect(f.focus()).toBe(false)
    }
  })
  it('ignores focus set by code or a click, with no key before it', () => {
    const { f } = make()
    expect(f.focus()).toBe(false)
    f.key('Tab')
    f.pointer()
    expect(f.focus()).toBe(false)
  })
  it('lets a Tab move focus only once, and not long after the key', () => {
    const a = make()
    a.f.key('Tab')
    expect(a.f.focus()).toBe(true)
    expect(a.f.focus()).toBe(false)
    const b = make()
    b.f.key('Tab')
    b.tick(2000)
    expect(b.f.focus()).toBe(false)
  })
  it('a later Escape cancels an earlier Tab', () => {
    const { f } = make()
    f.key('Tab')
    f.key('Escape')
    expect(f.focus()).toBe(false)
  })
})
