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

export const markOpenStarted = (name: string): void => mark((t, now) => t.openStarted(name, now))
export const markOpenStage = (stage: OpenStage, extra?: { parsedIn?: OpenTiming['parsedIn']; at?: number }): void => mark((t, now) => t.openStage(stage, { ...extra, now }))
export const markOpenEnded = (): void => mark((t, now) => t.openEnded(now))
export const markViewDrawn = (mountedAt: number, firstDrawMs: number | null): void => mark((t, now) => t.viewDrawn(mountedAt, firstDrawMs, now))
