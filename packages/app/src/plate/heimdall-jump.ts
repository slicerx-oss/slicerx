// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The jump to a strike: its moment on Preview's own timeline, the sliders and the playback stop there.
import type { Collision } from '@slicerx/contracts'
import { buildTimeline, changeBefore, fitOf, timeAt } from '../lib/preview-timeline'
import { toolChangerFor } from '../lib/toolchanger'
import { get, set, type AppState } from '../state/store'
import { collisionsOf } from './heimdall'
import { cameraBus } from './tools'

/** The playback time of a collision's first moment on Preview's own timeline, or null without a preview. */
export function collisionTime(s: AppState, c: Collision): number | null {
  const p = s.preview
  if (!p || c.layer >= p.layerCount) return null
  const tl = buildTimeline(p, toolChangerFor(s), fitOf(s.slice.status === 'done' ? s.slice.result.stats : null))
  const a = p.layerStart[c.layer] ?? 0
  const b = p.layerStart[c.layer + 1] ?? a
  const seg = a + Math.min(c.segment, Math.max(0, b - a - 1))
  if (c.change) {
    const ch = changeBefore(tl, seg)
    if (ch) return ch.start + Math.min(1, Math.max(0, c.change[2])) * ch.duration
  }
  // Halfway along the move, so the moment lands inside its layer even on the layer's first move.
  return timeAt(tl, p, c.layer + 1, b > a ? (seg - a + 0.5) / (b - a) : 1)
}

let jumps = 0

/**
 * Shows collision `i`: the sliders go to its moment, the head is drawn there, and the playback bar plays the seconds
 * before it and stops on it.
 */
export function jumpTo(i: number): void {
  const s = get()
  const c = collisionsOf(s)[i]
  if (!c) return
  const p = s.preview
  const a = p?.layerStart[c.layer] ?? 0
  const b = p?.layerStart[c.layer + 1] ?? a
  const t = collisionTime(s, c)
  set({
    strikePick: i,
    showToolhead: true,
    layerLo: 1,
    layerHi: c.layer + 1,
    moveCut: b > a ? Math.min(1, (Math.min(c.segment, b - a - 1) + 0.5) / (b - a)) : 1,
    toolChange: null,
    ...(t !== null ? { strikeJump: { timeS: t, seq: ++jumps } } : {}),
  })
  cameraBus()?.focusBedPoint?.(c.worstPoint[0], c.worstPoint[1], c.worstPoint[2], { animate: true })
}

