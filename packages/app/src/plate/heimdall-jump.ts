// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The jump to a strike: its moment on Preview's own timeline, the sliders and the playback stop there.
import type { Collision } from '@slicerx/contracts'
import { buildTimeline, changeBefore, fitOf, timeAt } from '../lib/preview-timeline'
import { toolChangerFor } from '../lib/toolchanger'
import { get, set, type AppState } from '../state/store'
import { collisionParts, collisionsOf } from './heimdall'
import { currentEdition } from '../edition'
import { presetFor } from '../first-run/look'
import { isPhoneLayout } from '../lib/phone-layout'
import { pickParts } from './pick-parts'
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
 * Opens Slice's summary pane, on the side the settings leave free, at the collision list: the way Show me on a strike
 * leads there. Only a person's click does this; a slice, refused or not, never opens it by itself. A phone keeps its
 * sheet down, so the parts the strike names stay in view; its list is a tab away.
 */
export function openCollisionList(): void {
  if (isPhoneLayout()) return
  const s = get()
  const side = presetFor(s.lookAndFeel ?? { id: currentEdition().firstRun.defaultLook }).layout.sidebar.side === 'left' ? 'right' : 'left'
  set({ rails: { ...s.rails, preview: { ...s.rails['preview'], [side]: true } }, rightShut: null })
  if (typeof requestAnimationFrame !== 'function' || typeof document === 'undefined') return
  // The list draws with the pane: bring it into view once it is there.
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector('[data-section="collisions"]')?.scrollIntoView({ block: 'start' })))
}

/**
 * Picks the parts of collision `i` from its row: they become the selection, ringed on the bed, and the view frames them
 * when some of them are off screen. Its strike is the one marked; the sliders stay where they are.
 */
export function pickCollision(i: number): string[] {
  const s = get()
  const c = collisionsOf(s)[i]
  if (!c) return []
  set({ strikePick: i })
  return pickParts(collisionParts(s, c))
}

/**
 * Shows collision `i`: its parts are selected, the sliders go to its moment, the head is drawn there, and the playback
 * bar plays the seconds before it and stops on it. The camera turns to the strike; with `frame` it frames the parts
 * instead, when some of them are off screen (Show me).
 */
export function jumpTo(i: number, opts: { frame?: boolean } = {}): void {
  const s = get()
  const c = collisionsOf(s)[i]
  if (!c) return
  pickParts(collisionParts(s, c), { frame: opts.frame === true })
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
  if (!opts.frame) cameraBus()?.focusBedPoint?.(c.worstPoint[0], c.worstPoint[1], c.worstPoint[2], { animate: true })
}

