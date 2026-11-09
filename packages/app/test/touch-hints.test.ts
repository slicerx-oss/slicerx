// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A hint names the gesture the pointer has: a right click for a mouse, press and hold for a finger.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rightClickWords } from '../src/lib/phone-layout'
import { RailFoot } from '../src/filament/slot-rail'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function foot(coarse: boolean): string {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)', media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }))
  const el = document.createElement('div')
  document.body.appendChild(el)
  flushSync(() => createRoot(el).render(createElement(RailFoot, { fromPrinter: true, system: 'ams', edited: false })))
  return el.textContent ?? ''
}

describe('the gesture in a hint', () => {
  it('is a right click for a mouse and press and hold on touch', () => {
    expect(rightClickWords(false)).toBe('Right-click')
    expect(rightClickWords(true)).toBe('Press and hold')
    expect(rightClickWords(true, false)).toBe('press and hold')
  })

  it('reads the spool hint under the rail by pointer', () => {
    expect(foot(false)).toContain('Right-click a spool to change it.')
    expect(foot(true)).toContain('Press and hold a spool to change it.')
  })
})
