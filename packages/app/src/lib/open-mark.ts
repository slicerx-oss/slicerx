// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Marks for the timing of file opens and of the 3D view's start (open-timing.ts), without that module in the app's
// startup code: it loads with the first mark. Each mark keeps the moment it was made, and marks land in the order they
// were made.
import type { OpenStage, OpenTiming } from './open-timing'

type Timing = typeof import('./open-timing')

let timing: Promise<Timing> | null = null

function mark(fn: (t: Timing, now: number) => void): void {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  void (timing ??= import('./open-timing')).then((t) => fn(t, now), () => undefined)
}

// The stages the open in progress has passed, for the loading wait over the plate (ravens/loading-phase.ts).
let passed: ReadonlySet<OpenStage> = new Set()
// Only an open in progress counts: a frame drawn after it ended, or a load that is not an open, adds nothing.
let opening = false
const listeners = new Set<() => void>()
const pass = (next: ReadonlySet<OpenStage>): void => {
  passed = next
  for (const l of listeners) l()
}

/** The stages the open in progress has passed, empty between opens. A new set each time one is added. */
export const openStagesPassed = (): ReadonlySet<OpenStage> => passed

/** Calls `fn` whenever an open starts or passes a stage; returns the unsubscribe. */
export function onOpenStage(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const markOpenStarted = (name: string): void => {
  opening = true
  pass(new Set())
  mark((t, now) => t.openStarted(name, now))
}
export const markOpenStage = (stage: OpenStage, extra?: { parsedIn?: OpenTiming['parsedIn']; at?: number }): void => {
  if (opening && !passed.has(stage)) pass(new Set([...passed, stage]))
  mark((t, now) => t.openStage(stage, { ...extra, now }))
}
export const markOpenEnded = (): void => {
  opening = false
  pass(new Set())
  mark((t, now) => t.openEnded(now))
}
export const markViewDrawn = (mountedAt: number, firstDrawMs: number | null, startup?: () => Record<string, number | null> | null): void =>
  mark((t, now) => t.viewDrawn(mountedAt, firstDrawMs, now, startup))
