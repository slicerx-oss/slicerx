// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The playback timeline: tool changes take their own time before the first move of the new tool, and
// scrubbing by time or by moves lands on the same place from either side.
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT, SXPV_SEGMENT_BYTES, SXPV_VERSION, readPreview, type PreviewBuffers } from '@slicerx/contracts'
import { toolChangerSpec } from '@slicerx/viewport'
import { CHANGE_SHARE, buildTimeline, clock, movesAt, movesOf, positionAt, sliderOf, timeAt, timeOfSlider, type Timeline } from '../src/lib/preview-timeline'
import { toolChangerFor } from '../src/lib/toolchanger'
import { LayerDock } from '../src/workspaces/preview/preview-hud'
import { get, set, type ProfileInfo } from '../src/state/store'

/** Layers of segments (x0, x1, tool) along y 0, 100 mm/s, 10 s a layer. */
function preview(layers: [number, number, number][][]): PreviewBuffers {
  const N = layers.length
  const S = layers.reduce((a, l) => a + l.length, 0)
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + (N + 1) * 4 + N * 8 + S * SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, S, true)
  dv.setUint32(12, N, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  let first = 0
  layers.forEach((l, k) => {
    dv.setUint32(o + k * 4, first, true)
    first += l.length
  })
  dv.setUint32(o + N * 4, S, true)
  o += (N + 1) * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 0.2 * (k + 1), true))
  o += N * 4
  layers.forEach((_, k) => dv.setFloat32(o + k * 4, 10, true))
  o += N * 4
  layers.forEach((l, k) => {
    for (const [x0, x1, tool] of l) {
      dv.setFloat32(o, x0, true)
      dv.setFloat32(o + 4, 0, true)
      dv.setFloat32(o + 8, x1, true)
      dv.setFloat32(o + 12, 0, true)
      dv.setFloat32(o + 16, 0.2 * (k + 1), true)
      dv.setUint16(o + 20, 400, true)
      dv.setUint16(o + 22, 200, true)
      dv.setUint8(o + 24, 0)
      dv.setUint8(o + 25, tool)
      dv.setUint16(o + 26, 1000, true)
      o += SXPV_SEGMENT_BYTES
    }
  })
  return readPreview(raw)
}

const u1 = toolChangerSpec('snapmaker-u1', { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5', travel_speed: '350' }, { widthMm: 270, depthMm: 270, heightMm: 270 }, 4)!

describe('preview timeline with tool changes', () => {
  const p = preview([
    [[0, 10, 0], [10, 20, 0], [20, 30, 1], [30, 40, 1]],
    [[40, 50, 1], [50, 60, 2]],
  ])

  it('inserts each change before the first move of its tool and lengthens the print by it', () => {
    const plain = buildTimeline(p)
    expect(plain.total).toBeCloseTo(20)
    expect(plain.changes).toEqual([])
    const tl = buildTimeline(p, u1)
    expect(tl.changes.map((c) => [c.segment, c.from, c.to])).toEqual([
      [2, 0, 1],
      [5, 1, 2],
    ])
    const [a, b] = tl.changes
    expect(a!.start).toBeCloseTo(5)
    expect(a!.fixed).toBe(5)
    expect(a!.duration).toBeGreaterThan(5)
    expect(b!.start).toBeCloseTo(10 + a!.duration + 5)
    expect(tl.total).toBeCloseTo(20 + a!.duration + b!.duration)
    expect(buildTimeline(p, u1)).toBe(tl)
  })

  it('maps a time inside a change to the moves before it and the seconds into it', () => {
    const tl = buildTimeline(p, u1)
    const a = tl.changes[0]!
    const inside = positionAt(tl, p, a.start + 1.25)
    expect(inside).toEqual({ layerHi: 1, moveCut: 0.5, change: { segment: 2, seconds: 1.25, fixed: 5 } })
    // Just before the change the move ahead of it is nearly done; just after it the next move has just begun.
    const before = positionAt(tl, p, a.start - 0.01)
    expect(before.change).toBeUndefined()
    expect(before.moveCut).toBeCloseTo(0.5, 2)
    expect(before.moveCut).toBeLessThan(0.5)
    const after = positionAt(tl, p, a.start + a.duration + 0.01)
    expect(after.change).toBeUndefined()
    expect(after.moveCut).toBeCloseTo(0.5, 2)
    expect(after.moveCut).toBeGreaterThan(0.5)
    // The change at the start of a layer belongs to that layer.
    const b = tl.changes[1]!
    expect(positionAt(tl, p, b.start + 0.5)).toEqual({ layerHi: 2, moveCut: 0.5, change: { segment: 5, seconds: 0.5, fixed: 5 } })
  })

  it('is exact both ways: the moves slider at a change lands on its start, and the time there maps back', () => {
    const tl = buildTimeline(p, u1)
    const a = tl.changes[0]!
    expect(timeAt(tl, p, 1, 0.5)).toBeCloseTo(a.start)
    const pos = positionAt(tl, p, timeAt(tl, p, 1, 0.75))
    expect(pos.layerHi).toBe(1)
    expect(pos.moveCut).toBe(0.75)
    expect(timeAt(tl, p, 2, 1)).toBeCloseTo(tl.total)
    // A time maps to the move being drawn; that move's end time maps back to the same place.
    for (const t of [0.5, 7, a.start + 2, 19.9, tl.total - 0.1]) {
      const q = positionAt(tl, p, t)
      const back = timeAt(tl, p, q.layerHi, q.moveCut)
      // Inside a change the moves slider stands at the change's start; elsewhere at the end of the move.
      if (q.change) expect(back).toBeCloseTo(a.start)
      else expect(back).toBeGreaterThanOrEqual(t - 1e-6)
      const q2 = positionAt(tl, p, back)
      expect([q2.layerHi, q2.moveCut]).toEqual([q.layerHi, q.moveCut])
    }
  })
})

/** Two layers: 4 segments of 10 mm at 50 mm/s in the first (20 s), 2 of 10 mm at 25 mm/s in the second (10 s). */
function fixture(): PreviewBuffers {
  const segs = [...Array(4).fill(50), ...Array(2).fill(25)]
  const raw = new ArrayBuffer(segs.length * SXPV_SEGMENT_BYTES)
  const v = new DataView(raw)
  segs.forEach((speed, i) => {
    const o = i * SXPV_SEGMENT_BYTES
    v.setFloat32(o + SXPV_SEGMENT.x0, 0, true)
    v.setFloat32(o + SXPV_SEGMENT.x1, 10, true)
    v.setUint16(o + SXPV_SEGMENT.speedDeciMmS, speed * 10, true)
  })
  return {
    raw, segmentCount: 6, layerCount: 2, layerStart: Uint32Array.from([0, 4, 6]), layerTimeS: Float32Array.from([20, 10]), segmentsOffset: 0, toolCount: 1,
  } as unknown as PreviewBuffers
}

describe('preview timeline', () => {
  it('sums layer times and splits a layer by segment time', () => {
    const p = fixture()
    const tl = buildTimeline(p)
    expect(tl.total).toBe(30)
    expect(Array.from(tl.layerEnd)).toEqual([20, 30])
    expect(Array.from(tl.segEnd).map((x) => Math.round(x))).toEqual([5, 10, 15, 20, 25, 30])
  })

  it('maps time to a layer and move share and back', () => {
    const p = fixture()
    const tl = buildTimeline(p)
    // Layer 1 is four 5 s moves, layer 2 two. At 0 s nothing is drawn yet; mid-move the share is part of a move.
    expect(positionAt(tl, p, 0)).toEqual({ layerHi: 1, moveCut: 0 })
    expect(positionAt(tl, p, 12).layerHi).toBe(1)
    expect(positionAt(tl, p, 12).moveCut).toBeCloseTo((2 + 0.4) / 4)
    expect(positionAt(tl, p, 21).layerHi).toBe(2)
    expect(positionAt(tl, p, 21).moveCut).toBeCloseTo((0 + 0.2) / 2)
    expect(positionAt(tl, p, 99)).toEqual({ layerHi: 2, moveCut: 1 })
    expect(timeAt(tl, p, 1, 0.5)).toBe(10)
    expect(timeAt(tl, p, 2, 1)).toBe(30)
    expect(timeAt(tl, p, 2, 0)).toBe(20)
  })

  it('plays part of the way along a move at its own pace, and maps that point back to the same time', () => {
    const p = fixture()
    const tl = buildTimeline(p)
    // Halfway through the first 5 s move: half a move of four drawn, not none and not all of it.
    expect(positionAt(tl, p, 2.5).moveCut).toBeCloseTo(0.5 / 4)
    // Every frame advances: two close times give two different shares, in order.
    const a = positionAt(tl, p, 6).moveCut
    const b = positionAt(tl, p, 6.1).moveCut
    expect(b).toBeGreaterThan(a)
    for (const t of [0, 2.5, 7.25, 12, 19.9, 21, 29]) {
      const q = positionAt(tl, p, t)
      expect(timeAt(tl, p, q.layerHi, q.moveCut)).toBeCloseTo(t, 4)
    }
  })

  it('formats clock readouts', () => {
    expect(clock(249)).toBe('4:09')
    expect(clock(3909)).toBe('1:05:09')
  })
})

describe('time slider track', () => {
  const tl = (total: number, changes: [number, number][]) =>
    ({ total, layerEnd: new Float64Array(), segEnd: new Float32Array(), changes: changes.map(([start, duration], i) => ({ segment: i + 1, from: 0, to: 1, start, duration, fixed: 0 })) }) as Timeline

  it('gives short changes a share of the track, continuous and monotonic, and maps back exactly', () => {
    const t = tl(10000, [[3000, 35], [6000, 40]])
    expect(sliderOf(t, 0)).toBe(0)
    expect(sliderOf(t, t.total)).toBeCloseTo(t.total, 6)
    // Both changes together take CHANGE_SHARE of the track.
    const width = sliderOf(t, 3035) - sliderOf(t, 3000) + (sliderOf(t, 6040) - sliderOf(t, 6000))
    expect(width / t.total).toBeCloseTo(CHANGE_SHARE, 9)
    let prev = -1
    for (let x = 0; x <= t.total; x += 7.3) {
      const v = sliderOf(t, x)
      expect(v).toBeGreaterThan(prev)
      expect(timeOfSlider(t, v)).toBeCloseTo(x, 6)
      prev = v
    }
    // Inside a change the track moves many times faster than the print: a drag can play it slowly.
    expect((sliderOf(t, 3020) - sliderOf(t, 3010)) / 10).toBeGreaterThan(15)
  })

  it('stays linear when there are no changes or they already take their share', () => {
    expect(sliderOf(tl(100, []), 42)).toBe(42)
    const busy = tl(100, [[10, 20], [50, 20]])
    expect(sliderOf(busy, 42)).toBe(42)
    expect(timeOfSlider(busy, 42)).toBe(42)
  })
})

describe('scrubbing the Time slider', () => {
  const p = preview([
    [[0, 10, 0], [10, 20, 0], [20, 30, 1], [30, 40, 1]],
    [[40, 50, 1], [50, 60, 2]],
  ])
  const profile = { printerId: 'snapmaker-u1', nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'orca' } as unknown as ProfileInfo

  it('updates the view on every step of a drag and keeps the handle where it was dragged, inside a change too', () => {
    set({ preview: p, layerHi: 2, moveCut: 1, toolChange: null, workspace: 'preview', settingsMode: 'advanced', profile, overrides: { nozzle_diameter: ['0.4', '0.4', '0.4', '0.4'], machine_tool_change_time: '5', travel_speed: '350' }, bed: { widthMm: 270, depthMm: 270, heightMm: 270 } })
    const el = document.createElement('div')
    document.body.append(el)
    flushSync(() => createRoot(el).render(createElement(LayerDock)))
    const slider = el.querySelector('#pv-time') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    // As a pointer drag does: the input's value moves and an input event fires for each step.
    const drag = (v: number) =>
      flushSync(() => {
        setValue.call(slider, String(v))
        slider.dispatchEvent(new Event('input', { bubbles: true }))
      })
    const tl = buildTimeline(p, toolChangerFor(get()))
    const c = tl.changes[0]!
    expect(c).toBeDefined()
    // Steps through the change: each plays it further, and the handle stays where the drag put it.
    let last = -1
    for (const f of [0.1, 0.35, 0.6, 0.9]) {
      const v = sliderOf(tl, c.start + c.duration * f)
      drag(v)
      const s = get()
      expect(s.toolChange?.segment).toBe(c.segment)
      expect(s.toolChange!.seconds).toBeCloseTo(c.duration * f, 2)
      expect(s.toolChange!.seconds).toBeGreaterThan(last)
      last = s.toolChange!.seconds
      expect(Number(slider.value)).toBeCloseTo(v, 2)
    }
    // Between moves the handle stays where it was dragged instead of jumping to the end of the last move.
    const mid = sliderOf(tl, 2.5)
    drag(mid)
    expect(Number(slider.value)).toBeCloseTo(mid, 2)
    expect(get().toolChange).toBeNull()
    el.remove()
  })
})

describe('moves slider through a tool change', () => {
  const p = preview([
    [[0, 10, 0], [10, 20, 0], [20, 30, 1], [30, 40, 1]],
    [[40, 50, 1], [50, 60, 2]],
  ])

  it('gives the change in a layer the track its time is worth, and maps back exactly', () => {
    const tl = buildTimeline(p, u1)
    const c = tl.changes[0]!
    // Layer 1: 4 moves of 2.5 s and a change of c.duration seconds before the third move.
    const width = 4 + c.duration / 2.5
    expect(movesOf(tl, p, 1, 0.5)).toBeCloseTo(2 / width, 9)
    expect(movesOf(tl, p, 1, 0.5, { segment: c.segment, seconds: c.duration / 2 })).toBeCloseTo((2 + c.duration / 5) / width, 9)
    expect(movesOf(tl, p, 1, 0.75)).toBeCloseTo((3 + c.duration / 2.5) / width, 9)
    expect(movesOf(tl, p, 1, 1)).toBeCloseTo(1, 9)
    for (const u of [0, 0.1, 0.25, 0.4, 0.6, 0.8, 0.95, 1]) {
      const q = movesAt(tl, p, 1, u)
      expect(movesOf(tl, p, 1, q.moveCut, q.change ?? null)).toBeCloseTo(u, 9)
    }
    // Inside the change the seconds grow with the slider, from 0 to the whole change.
    const into = movesAt(tl, p, 1, (2 + c.duration / 2.5 / 2) / width)
    expect(into.change).toEqual({ segment: c.segment, seconds: c.duration / 2, fixed: c.fixed })
    expect(into.moveCut).toBe(0.5)
  })

  it('stays a plain share of the moves in a layer without a change', () => {
    const tl = buildTimeline(p)
    expect(movesOf(tl, p, 1, 0.3)).toBeCloseTo(0.3, 9)
    expect(movesAt(tl, p, 1, 0.3)).toEqual({ moveCut: 0.3 })
  })
})
