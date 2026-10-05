// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Work that is not needed for the first picture (shader warm-up for views not yet open) waits here until the
// plate has been drawn once, so a slow shader compiler cannot hold the first frame back.

export class FirstFrameGate {
  private queue: (() => void)[] | null = []
  private t0 = performance.now()
  /** Milliseconds from construction to the first drawn frame, or null before it. */
  ms: number | null = null

  /** Runs `fn` after the first frame; at once if that frame is already out. */
  after(fn: () => void): void {
    if (this.queue) this.queue.push(fn)
    else fn()
  }

  /** Called after every frame; the first call releases the queue. */
  frame(): void {
    if (!this.queue) return
    const q = this.queue
    this.queue = null
    this.ms = performance.now() - this.t0
    for (const fn of q) fn()
  }
}
