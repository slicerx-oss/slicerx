// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The bottom panel opens 120 ms into the band along the bottom of the view, closes 600 ms after the pointer leaves,
// never while it is held (hovered, focused, a menu, a drag), opens for attention for 4 s, and stays open when pinned.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTENTION_MS, AutoPanel, CLOSE_DELAY_MS, OPEN_DELAY_MS } from '../src/shell/auto-panel'

let p: AutoPanel
const changes: boolean[] = []

beforeEach(() => {
  vi.useFakeTimers()
  changes.length = 0
  p = new AutoPanel((open) => changes.push(open))
})
afterEach(() => {
  p.dispose()
  vi.useRealTimers()
})

describe('the bottom panel', () => {
  it('opens after a short rest in the band, not on a pass across it', () => {
    p.band(true)
    vi.advanceTimersByTime(OPEN_DELAY_MS - 20)
    p.band(false)
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
    p.band(true)
    vi.advanceTimersByTime(OPEN_DELAY_MS)
    expect(p.open).toBe(true)
  })

  it('closes 600 ms after the pointer leaves the band and the panel, and not while it is over the panel', () => {
    p.band(true)
    vi.advanceTimersByTime(OPEN_DELAY_MS)
    p.panel(true)
    p.band(false)
    vi.advanceTimersByTime(5000)
    expect(p.open).toBe(true)
    p.panel(false)
    vi.advanceTimersByTime(CLOSE_DELAY_MS - 10)
    expect(p.open).toBe(true)
    vi.advanceTimersByTime(10)
    expect(p.open).toBe(false)
  })

  it('stays open while focus is inside, a menu is open or a drag is under way', () => {
    p.toggle()
    for (const [hold, release] of [[() => p.focus(true), () => p.focus(false)], [() => p.menuOpen(true), () => p.menuOpen(false)], [() => p.drag(true), () => p.drag(false)]] as const) {
      hold()
      vi.advanceTimersByTime(5000)
      expect(p.open).toBe(true)
      release()
      p.band(true)
      p.band(false)
    }
    vi.advanceTimersByTime(CLOSE_DELAY_MS)
    expect(p.open).toBe(false)
  })

  it('opens at once from its tab and closes from it, and Escape closes it', () => {
    p.toggle()
    expect(p.open).toBe(true)
    p.toggle()
    expect(p.open).toBe(false)
    p.focus(true)
    expect(p.open).toBe(true)
    p.close()
    expect(p.open).toBe(false)
  })

  it('opens for attention and closes again after 4 s unless the pointer comes to it', () => {
    p.attention()
    expect(p.open).toBe(true)
    vi.advanceTimersByTime(ATTENTION_MS)
    expect(p.open).toBe(false)
    p.attention()
    p.panel(true)
    vi.advanceTimersByTime(ATTENTION_MS * 2)
    expect(p.open).toBe(true)
  })

  it('stays open when pinned, and Escape does not close it', () => {
    p.pin(true)
    expect(p.open).toBe(true)
    p.band(true)
    p.band(false)
    vi.advanceTimersByTime(5000)
    p.close()
    expect(p.open).toBe(true)
    p.pin(false)
    vi.advanceTimersByTime(CLOSE_DELAY_MS)
    expect(p.open).toBe(false)
  })
})

describe('timeline chips', async () => {
  const { chipName } = await import('../src/workspaces/design/timeline')
  it('use a short name with the main number', () => {
    const chip = (params: unknown) => chipName({ params } as never)
    expect(chip({ op: 'shell', open: [{}], wallMm: 2 })).toBe('Shell 2')
    expect(chip({ op: 'edge.fillet', edges: [{}, {}], radiusMm: 5 })).toBe('Fillet 5')
    expect(chip({ op: 'shape.extrude', shape: { type: 'sketch', loops: [] }, spec: { distanceMm: 30, operation: 'new' } })).toBe('Sketch extrude 30')
    expect(chip({ op: 'hole.apply', hole: {}, spec: {}, label: 'Hole M3, 4 places' })).toBe('Hole M3')
  })
})
