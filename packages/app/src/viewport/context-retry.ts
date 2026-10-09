// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The 3D view's WebGL2 context, asked for again before giving up. A browser's graphics process can exit just after it
// starts and come back a few hundred milliseconds later; a context asked for in between fails. So the view tries again
// at about 300, 800 and 1500 ms before it opens in its 2D fallback, and after that it keeps checking, less and less
// often, so the session returns to 3D once a context can be had.

/** When the view asks again for a context, in ms from its first try. */
export const RETRY_AT_MS = [300, 800, 1500] as const

/** How long the 2D fallback waits between checks for a WebGL2 context: from the first wait, doubling to the last. */
export const WATCH_MS = { first: 5_000, max: 60_000 } as const

export type Sleep = (ms: number) => Promise<void>
const sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** `make`'s first result, trying it now and again at each of `at` (ms from now); the last error when every try fails. */
export async function withRetries<T>(make: () => T | Promise<T>, at: readonly number[] = RETRY_AT_MS, wait: Sleep = sleep): Promise<T> {
  let last: unknown
  let now = 0
  for (const when of [0, ...at]) {
    if (when > now) await wait(when - now)
    now = when
    try {
      return await make()
    } catch (e) {
      last = e
    }
  }
  throw last
}

/**
 * Calls `ready` once `probe` says a context can be had, checking every `first` ms, then twice as long each time up to
 * `max`. Returns a function that stops it.
 */
export function watchFor(probe: () => boolean, ready: () => void, timing: { first: number; max: number } = WATCH_MS, wait: Sleep = sleep): () => void {
  let stopped = false
  void (async () => {
    for (let gap = timing.first; !stopped; gap = Math.min(timing.max, gap * 2)) {
      await wait(gap)
      if (stopped) return
      if (probe()) {
        ready()
        return
      }
    }
  })()
  return () => {
    stopped = true
  }
}

/** Whether this browser gives a WebGL2 context now. The context is given back at once. */
export function webgl2Available(): boolean {
  const gl = document.createElement('canvas').getContext('webgl2')
  gl?.getExtension('WEBGL_lose_context')?.loseContext()
  return gl !== null
}
