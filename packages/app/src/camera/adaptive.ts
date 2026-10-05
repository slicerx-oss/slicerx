// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Adaptive quality for the camera player. It steps down quickly when the stream stutters or lags and
// steps up slowly once it has been smooth for a while, so the picture settles instead of flapping.
import { QUALITIES, QUALITY_SPEC, type Quality, type StreamStats } from './stream'

export interface AdaptState {
  quality: Quality
  /** Consecutive bad and good seconds. */
  bad: number
  good: number
}

/** Seconds of trouble before stepping down, and of smooth running before stepping up. */
export const DOWN_AFTER = 2
export const UP_AFTER = 8
export const MAX_LATENCY_MS = 800
export const GOOD_LATENCY_MS = 300

export function initialAdapt(start: Quality): AdaptState {
  return { quality: start, bad: 0, good: 0 }
}

/** One second of stats in, the next state out. `supported` is the camera's own levels, lightest first. */
export function adapt(state: AdaptState, stats: StreamStats, supported: readonly Quality[] = QUALITIES): AdaptState {
  const levels = QUALITIES.filter((q) => supported.includes(q))
  const i = Math.max(0, levels.indexOf(state.quality))
  const target = QUALITY_SPEC[state.quality].fps
  const bad = stats.fps < target * 0.7 || stats.latencyMs > MAX_LATENCY_MS
  const good = stats.fps >= target * 0.95 && stats.latencyMs < GOOD_LATENCY_MS
  if (bad) {
    const n = state.bad + 1
    if (n >= DOWN_AFTER && i > 0) return { quality: levels[i - 1]!, bad: 0, good: 0 }
    return { ...state, bad: n, good: 0 }
  }
  if (good) {
    const n = state.good + 1
    if (n >= UP_AFTER && i < levels.length - 1) return { quality: levels[i + 1]!, bad: 0, good: 0 }
    return { ...state, bad: 0, good: n }
  }
  return { ...state, bad: 0, good: 0 }
}
