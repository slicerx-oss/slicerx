// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPACT_QUERY, PHONE_QUERY, useCompactLayout, usePhoneLayout, usePhoneRoot } from '../src/lib/phone-layout'

/** A window at a width, with a touch screen or a mouse: every part of a query must hold. */
function screenAt(width: number, touch: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => {
    const max = /max-width: (\d+)px/.exec(q)
    const coarse = q.includes('pointer: coarse')
    const matches = (!max || width <= Number(max[1])) && (!coarse || touch)
    return { matches, addEventListener() {}, removeEventListener() {} }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-phone')
})

describe('phone layout', () => {
  it('is compact at 900 px or less, whatever the pointer', () => {
    expect(COMPACT_QUERY).toBe('(max-width: 900px)')
    for (const touch of [false, true]) {
      screenAt(900, touch)
      expect(renderHook(() => useCompactLayout()).result.current).toBe(true)
      screenAt(901, touch)
      expect(renderHook(() => useCompactLayout()).result.current).toBe(false)
    }
  })

  it('is a phone only on a touch screen 900 px or less', () => {
    expect(PHONE_QUERY).toBe('(pointer: coarse) and (max-width: 900px)')
    screenAt(390, true)
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(true)
    // a narrow desktop window keeps the full layout
    screenAt(800, false)
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
    // and so does a big tablet
    screenAt(1024, true)
    expect(renderHook(() => usePhoneLayout()).result.current).toBe(false)
  })

  it('marks the document root while a phone, and clears it after', () => {
    screenAt(390, true)
    const { unmount } = renderHook(() => usePhoneRoot())
    expect(document.documentElement.hasAttribute('data-phone')).toBe(true)
    unmount()
    expect(document.documentElement.hasAttribute('data-phone')).toBe(false)
    screenAt(800, false)
    renderHook(() => usePhoneRoot())
    expect(document.documentElement.hasAttribute('data-phone')).toBe(false)
  })
})
