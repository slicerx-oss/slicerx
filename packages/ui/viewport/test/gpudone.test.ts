// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The first preview frame is timed with a fence, polled across tasks, never a readback that holds the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FENCE_POLL_MS, gpuDone, type FenceGl } from '../src/gpudone'

function fakeGl(doneAfterLooks: number): FenceGl & { looks: number; deleted: number; flushed: number } {
  const g = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    TIMEOUT_EXPIRED: 0x911b,
    looks: 0,
    deleted: 0,
    flushed: 0,
    fenceSync: () => ({}) as WebGLSync,
    flush: () => void g.flushed++,
    // ALREADY_SIGNALED once the GPU is through
    clientWaitSync: () => (++g.looks > doneAfterLooks ? 0x911a : 0x911b),
    deleteSync: () => void g.deleted++,
  }
  return g as unknown as FenceGl & { looks: number; deleted: number; flushed: number }
}

describe('gpuDone', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('returns at once and resolves when the fence signals, looking once a few ms', async () => {
    const gl = fakeGl(3)
    const fallback = vi.fn()
    let done: number | null = null
    void gpuDone(gl, fallback).then((t) => (done = t))
    // nothing waited inside the call: the page goes on
    expect(gl.looks).toBe(0)
    expect(gl.flushed).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBeNull()
    await vi.advanceTimersByTimeAsync(FENCE_POLL_MS * 3)
    expect(done).not.toBeNull()
    expect(gl.looks).toBe(4)
    expect(gl.deleted).toBe(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('waits the old way only where there is no fence (WebGL 1)', async () => {
    const fallback = vi.fn()
    const t = await gpuDone({} as WebGLRenderingContext, fallback)
    expect(fallback).toHaveBeenCalledOnce()
    expect(typeof t).toBe('number')
  })
})
