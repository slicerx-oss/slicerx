// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first plate reveal: its timeline, the outline path the crackles follow, and once per window.
import { beforeEach, describe, expect, it } from 'vitest'
import { PerspectiveCamera } from 'three'
import { BLOOM_PEAK, legShare, outlinePoint, PlateReveal, REVEAL_DELAY_MS, REVEAL_DWELL_MS, REVEAL_END_MS, REVEAL_GRID_AFTER_MS, REVEAL_TRACE_MS, revealPlate, revealPlayed, resetRevealPlayed, traceShare, type RevealPlate } from '../src/reveal'

const at = (ms: number): RevealPlate => revealPlate(ms, { trace: 0, gridMs: 0, tint: 0 })

/** The plate shader's `traced` (stage.ts), point to place along the outline: the inverse of outlinePoint. */
function traced(x: number, y: number, hx: number, hy: number): number {
  const qx = Math.abs(x) - hx
  const qy = Math.abs(y) - hy
  const s = qx > qy ? hx + y + hy : y < 0 ? Math.abs(x) : 2 * hx + 2 * hy - Math.abs(x)
  return s / (2 * hx + 2 * hy)
}

describe('reveal timeline', () => {
  it('draws nothing before the trace starts', () => {
    expect(at(-1)).toEqual({ trace: -1, gridMs: -1, tint: 0 })
  })

  it('traces the outline front to back, then lays the grid', () => {
    let last = -Infinity
    for (let ms = 0; ms <= REVEAL_TRACE_MS; ms += 20) {
      const p = at(ms)
      expect(p.trace).toBeGreaterThanOrEqual(last)
      expect(p.gridMs).toBeLessThan(0)
      last = p.trace
    }
    expect(at(REVEAL_TRACE_MS).trace).toBe(1)
    expect(at(REVEAL_TRACE_MS + REVEAL_GRID_AFTER_MS + 10).gridMs).toBeCloseTo(10)
  })

  it('washes the plate on the hit, keeps a faint tint while the grid lands, and ends with none', () => {
    expect(at(REVEAL_TRACE_MS - 1).tint).toBe(0)
    expect(at(REVEAL_TRACE_MS + 126).tint).toBeCloseTo(1, 1)
    const mid = at(REVEAL_TRACE_MS + 600).tint
    expect(mid).toBeGreaterThanOrEqual(0.45)
    expect(mid).toBeLessThan(1)
    expect(at(REVEAL_END_MS - 1).tint).toBeLessThan(0.01)
  })

  it('ends on the plate as it is always drawn', () => {
    expect(at(REVEAL_END_MS)).toEqual({ trace: 1, gridMs: 1e9, tint: 0 })
    expect(REVEAL_DELAY_MS + REVEAL_END_MS).toBeLessThan(2200)
  })
})

describe('outline path', () => {
  const hx = 128
  const hy = 90
  const p = { x: 0, y: 0 }

  it('runs from the front middle round the corners to the back middle', () => {
    expect(outlinePoint(0, 1, hx, hy, p)).toEqual({ x: 0, y: -hy })
    const L = 2 * hx + 2 * hy
    expect(outlinePoint(hx / L, 1, hx, hy, p)).toEqual({ x: hx, y: -hy })
    expect(outlinePoint((hx + 2 * hy) / L, 1, hx, hy, p)).toEqual({ x: hx, y: hy })
    expect(outlinePoint(1, 1, hx, hy, p)).toEqual({ x: 0, y: hy })
    expect(outlinePoint(0.3, -1, hx, hy, { x: 0, y: 0 }).x).toBe(-outlinePoint(0.3, 1, hx, hy, p).x)
  })

  it('matches the plate shader, so the drawn outline ends where the crackle head is', () => {
    for (let i = 0; i <= 100; i++) {
      const s = i / 100
      for (const side of [1, -1] as const) {
        outlinePoint(s, side, hx, hy, p)
        expect(traced(p.x, p.y, hx, hy)).toBeCloseTo(s, 6)
      }
    }
  })
})

describe('plate reveal', () => {
  beforeEach(() => resetRevealPlayed())

  const camera = new PerspectiveCamera(30, 1.6, 20, 1600)
  camera.position.set(0, 300, 400)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  // No parent element: the plate still runs, without the 2D overlay.
  const canvas = { parentElement: null, clientWidth: 800, clientHeight: 500 } as unknown as HTMLCanvasElement

  it('plays once per window and ends on the settled plate', () => {
    const r = new PlateReveal(canvas)
    const calls: number[][] = []
    const set = (a: number, b: number, c: number) => void calls.push([a, b, c])
    expect(revealPlayed()).toBe(false)
    expect(r.step(1000, camera, 128, 128, '#bd93f9', set)).toBe(true)
    expect(revealPlayed()).toBe(true)
    expect(calls.at(-1)).toEqual([-1, -1, 0])
    expect(r.step(1000 + REVEAL_DELAY_MS + 400, camera, 128, 128, '#bd93f9', set)).toBe(true)
    expect(calls.at(-1)![0]).toBeGreaterThan(0)
    expect(r.step(1000 + REVEAL_DELAY_MS + REVEAL_END_MS, camera, 128, 128, '#bd93f9', set)).toBe(false)
    expect(calls.at(-1)).toEqual([1, 1e9, 0])
    expect(r.done).toBe(true)
    expect(r.step(5000, camera, 128, 128, '#bd93f9', set)).toBe(false)
  })

  it('ends at once when cut short', () => {
    const r = new PlateReveal(canvas)
    const calls: number[][] = []
    r.step(0, camera, 128, 128, '#bd93f9', () => undefined)
    r.finish((a, b, c) => void calls.push([a, b, c]))
    expect(calls).toEqual([[1, 1e9, 0]])
    expect(r.done).toBe(true)
  })
})

describe('the trace moves like a mass on a track', () => {
  // a 256 by 200 mm bed: half the front is 128 mm, the side 200 mm
  const hx = 128
  const hy = 100
  const total = 2 * hx + 2 * hy
  const step = 1
  const speed = (ms: number) => ((traceShare(ms + step, hx, hy) - traceShare(ms - step, hx, hy)) * total) / (2 * step)
  const legMs = (REVEAL_TRACE_MS - 2 * REVEAL_DWELL_MS) / 3
  const corners = [legMs, 2 * legMs + REVEAL_DWELL_MS]

  it('starts from rest, rests in each corner, and arrives at the back slowly', () => {
    expect(speed(1)).toBeLessThan(0.01)
    for (const c of corners) {
      expect(speed(c - 2)).toBeLessThan(0.02)
      expect(speed(c + REVEAL_DWELL_MS / 2)).toBe(0)
      expect(speed(c + REVEAL_DWELL_MS + 2)).toBeLessThan(0.02)
    }
    expect(speed(REVEAL_TRACE_MS - 2)).toBeLessThan(0.02)
    // the corners are where the outline turns: the front corner after half the front, the back one after the side
    expect(traceShare(corners[0]! + 1, hx, hy) * total).toBeCloseTo(hx, 0)
    expect(traceShare(corners[1]! + 1, hx, hy) * total).toBeCloseTo(hx + 2 * hy, 0)
  })

  it('is fastest mid-leg, with peak speed scaled to the leg so every leg takes the same time', () => {
    const mids = [legMs / 2, legMs * 1.5 + REVEAL_DWELL_MS, legMs * 2.5 + 2 * REVEAL_DWELL_MS]
    for (const m of mids) {
      expect(speed(m)).toBeGreaterThan(speed(m - legMs / 4))
      expect(speed(m)).toBeGreaterThan(speed(m + legMs / 4))
    }
    // the side is 200 mm against 128 mm for half the front: its peak is that much faster
    expect(speed(mids[1]!) / speed(mids[0]!)).toBeCloseTo((2 * hy) / hx, 1)
  })

  it('never jumps: the speed changes smoothly from one millisecond to the next', () => {
    let last = speed(1)
    for (let ms = 2; ms < REVEAL_TRACE_MS - 1; ms += 1) {
      const v = speed(ms)
      expect(Math.abs(v - last)).toBeLessThan(0.05)
      last = v
    }
  })

  it('keeps the old timing: traced in REVEAL_TRACE_MS, a softer bloom', () => {
    expect(traceShare(REVEAL_TRACE_MS, hx, hy)).toBe(1)
    expect(traceShare(0, hx, hy)).toBe(0)
    expect(legShare(0.5)).toBeCloseTo(0.5)
    expect(BLOOM_PEAK).toBeLessThan(0.9)
  })
})
