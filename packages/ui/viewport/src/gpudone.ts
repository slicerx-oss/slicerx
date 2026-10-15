// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// When the GPU has finished what was queued, found without stalling the page: a fence, polled every few ms. A pixel
// readback waits for the same thing but holds the main thread for as long as the GPU takes, which on software WebGL
// is many seconds for a big preview.

/** The WebGL 2 calls a fence needs. */
export type FenceGl = Pick<WebGL2RenderingContext, 'fenceSync' | 'clientWaitSync' | 'deleteSync' | 'flush' | 'SYNC_GPU_COMMANDS_COMPLETE' | 'TIMEOUT_EXPIRED'>

/** How often a pending fence is looked at, ms. */
export const FENCE_POLL_MS = 4

/**
 * Resolves with `performance.now()` once the GPU has finished every command issued before the call. `fallback` runs
 * where there is no fence (WebGL 1) and has to wait itself. A lost context resolves at once.
 */
export function gpuDone(gl: FenceGl | WebGLRenderingContext, fallback: () => void): Promise<number> {
  const g = gl as FenceGl
  const sync = typeof g.fenceSync === 'function' ? g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0) : null
  if (!sync) {
    fallback()
    return Promise.resolve(performance.now())
  }
  g.flush()
  return new Promise((resolve) => {
    // the sync's status changes only between tasks, so each look is its own task
    const look = (): void => {
      if (g.clientWaitSync(sync, 0, 0) === g.TIMEOUT_EXPIRED) return void setTimeout(look, FENCE_POLL_MS)
      g.deleteSync(sync)
      resolve(performance.now())
    }
    setTimeout(look, 0)
  })
}

/** A look at the fence later than this after the one before, ms, was held up by the page, so the time is not the GPU's. */
export const FENCE_LATE_MS = 12

/**
 * Times frames on the GPU without stalling the page: `time` sets a fence after a frame's commands and calls back with
 * the time from `t0` until the GPU finished them. One frame is timed at once; frames drawn meanwhile go untimed. When
 * the page was busy between two looks (opening a project, building meshes), the fence may have signaled long before it
 * was seen, so that frame is dropped instead of reported slow.
 */
export class FrameFence {
  private pending = false
  private disposed = false

  constructor(private readonly gl: FenceGl) {}

  /** False when a frame is still being timed or the context has no fences. */
  time(t0: number, done: (ms: number) => void): boolean {
    const g = this.gl
    if (this.pending || this.disposed || typeof g.fenceSync !== 'function') return false
    const sync = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0)
    if (!sync) return false
    g.flush()
    this.pending = true
    let last = performance.now()
    let held = last - t0 > FENCE_LATE_MS * 4
    const look = (): void => {
      if (this.disposed) {
        g.deleteSync(sync)
        return
      }
      const now = performance.now()
      if (now - last > FENCE_LATE_MS) held = true
      last = now
      if (g.clientWaitSync(sync, 0, 0) === g.TIMEOUT_EXPIRED) return void setTimeout(look, 1)
      g.deleteSync(sync)
      this.pending = false
      if (!held) done(now - t0)
    }
    setTimeout(look, 0)
    return true
  }

  dispose(): void {
    this.disposed = true
  }
}
