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
