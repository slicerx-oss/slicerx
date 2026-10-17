// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { PreviewBuffers } from '@slicerx/contracts'
import { createStore } from 'zustand'
import { leadInStart, positionAt, timeAt, type Timeline } from '../../lib/preview-timeline'
import { get, set } from '../../state/store'

/** Keep a seek's precise clock, or recover the time of an independent layer or Moves scrub. */
export function playbackTime(preview: PreviewBuffers, timeline: Timeline, clock: number): number {
  const s = get()
  const p = positionAt(timeline, preview, clock)
  const top = Math.max(1, Math.min(s.layerHi, preview.layerCount))
  const synced = p.layerHi === top && Math.abs(p.moveCut - s.moveCut) < 1e-9 && (p.change?.segment ?? -1) === (s.toolChange?.segment ?? -1) && Math.abs((p.change?.seconds ?? 0) - (s.toolChange?.seconds ?? 0)) < 1e-6
  if (synced) return clock
  const change = s.toolChange && timeline.changes.find((c) => c.segment === s.toolChange!.segment)
  if (change) return change.start + Math.max(0, Math.min(s.toolChange!.seconds, change.duration))
  return timeAt(timeline, preview, top, s.moveCut)
}

/** The bar and app link share one clock, including time spent inside a tool change. */
export const playback = (() => {
  const state = createStore(() => ({ playing: false, time: 0 }))
  let bound: { preview: PreviewBuffers; timeline: Timeline } | null = null
  let frame: number | null = null
  let generation = 0
  let last = 0
  let stopAt: number | null = null
  const current = () => bound && get().preview === bound.preview ? bound : null

  function time() {
    const b = current()
    return b ? playbackTime(b.preview, b.timeline, state.getState().time) : 0
  }

  function pause() {
    generation++
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    stopAt = null
    state.setState({ playing: false })
  }

  function place(at: number) {
    const b = current()
    if (!b) return
    const pos = positionAt(b.timeline, b.preview, at)
    state.setState({ time: at })
    const s = get()
    if (pos.layerHi !== s.layerHi || pos.moveCut !== s.moveCut || (pos.change?.segment ?? -1) !== (s.toolChange?.segment ?? -1) || (pos.change?.seconds ?? 0) !== (s.toolChange?.seconds ?? 0)) {
      set({ layerHi: pos.layerHi, moveCut: pos.moveCut, toolChange: pos.change ?? null })
    }
  }

  function seek(seconds: number) {
    const b = current()
    if (!b || !Number.isFinite(seconds)) return
    stopAt = null
    place(Math.max(0, Math.min(seconds, b.timeline.total)))
    // A seek while playing begins a fresh frame interval at the requested time.
    last = performance.now()
  }

  function play() {
    const b = current()
    if (!b) return
    const at = time()
    if (state.getState().playing) {
      if (at >= b.timeline.total - 0.001) seek(0)
      return
    }
    place(at >= b.timeline.total - 0.001 ? 0 : at)
    state.setState({ playing: true })
    last = performance.now()
    const token = ++generation
    const tick = (now: number) => {
      if (token !== generation) return
      if (current() !== b) return pause()
      // A frame may predate the last seek or render; the print clock never goes backward.
      let next = Math.min(b.timeline.total, time() + Math.max(0, now - last) / 1000 * get().playbackSpeed)
      last = now
      const stopped = stopAt !== null && next >= stopAt
      if (stopped) next = stopAt!
      place(next)
      if (stopped || next >= b.timeline.total) pause()
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
  }

  function read() {
    const b = current()
    const s = get()
    return {
      available: !!b, sliced: s.preview !== null, playing: !!b && state.getState().playing,
      timeS: b ? time() : null, durationS: b?.timeline.total ?? null,
      speed: s.playbackSpeed, followNozzle: s.followNozzle,
      ...(b ? { layer: s.layerHi, moveShare: s.moveCut, toolChange: s.toolChange ? { ...s.toolChange } : null, stopAtS: stopAt } : {}),
    }
  }

  return {
    state, read, seek, play, pause,
    toggle() { stopAt = null; if (state.getState().playing) pause(); else play() },
    strike(seconds: number) {
      const b = current()
      if (!b) return
      pause()
      seek(leadInStart(b.timeline, b.preview, seconds, 2 * Math.max(0.25, get().playbackSpeed)))
      stopAt = Math.max(0, Math.min(seconds, b.timeline.total))
      play()
    },
    /** Only the mounted bar owns a timeline. Replacing or closing it cancels old callbacks. */
    bind(preview: PreviewBuffers, timeline: Timeline) {
      pause()
      const owner = { preview, timeline }
      bound = owner
      state.setState({ time: timeAt(timeline, preview, Math.max(1, Math.min(get().layerHi, preview.layerCount)), get().moveCut) })
      return () => { if (bound === owner) { pause(); bound = null } }
    },
  }
})()
