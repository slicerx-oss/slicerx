// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto slice and an agent's edits: a run of agent calls (mimir's tools, a client on the app link) starts no slice while
// it goes on and one when it has been quiet for AGENT_QUIET_MS; a person's edit slices as before; and a slice canceled
// while the engine still runs it is never joined by a new one: the next starts once it has stopped. Counted in slices
// started and slices running at once, never in seconds.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest } from '@slicerx/contracts'
import { STUCK_SLICE_MS } from '../src/state/actions'
import { AGENT_QUIET_MS, AUTO_SLICE_DELAY_MS, agentCall, startAutoSlice } from '../src/state/auto-slice'
import { set } from '../src/state/store'

const handle = { id: 'a', hash: 'a', name: 'a', triangles: 1, bboxMm: [10, 10, 10], openEdges: 0, parts: [{ name: 'a', slot: 1, triangles: 1 }] }
const entry = (x: number) => ({ id: 'a', name: 'a', handle, parts: [], colors: [], transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] }) as never

/** One layer of one move, enough for the app to read. */
function rawPreview(): ArrayBuffer {
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + 2 * 4 + 8 + SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, 1, true)
  dv.setUint32(12, 1, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  dv.setUint32(o, 0, true)
  dv.setUint32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o, 0.2, true)
  dv.setFloat32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o + 8, 10, true)
  dv.setFloat32(o + 16, 0.2, true)
  dv.setUint16(o + 20, 400, true)
  dv.setUint16(o + 22, 200, true)
  return raw
}

/**
 * An engine that, like the desktop one, does not stop a canceled slice at once: each slice runs until the test ends it
 * (`finish`), canceled or not. It counts the slices started and the most running at once.
 */
function engine() {
  const requests: SliceRequest[] = []
  const running: { done: () => void; signal: AbortSignal | undefined }[] = []
  let now = 0
  let most = 0
  const h = {
    kind: 'web',
    capabilities: { threads: 1 },
    slicer: {
      loadParts: async () => handle,
      loadModel: async () => handle,
      slice: (r: SliceRequest, o?: { signal?: AbortSignal }) => {
        requests.push(r)
        most = Math.max(most, ++now)
        return new Promise((resolve, reject) => {
          running.push({
            signal: o?.signal,
            done: () => {
              now--
              if (o?.signal?.aborted) reject(new DOMException('Slice canceled', 'AbortError'))
              else resolve({ id: `r${requests.length}`, layerZ: Float32Array.from([0.2]), warnings: [] })
            },
          })
        })
      },
      getPreview: async () => rawPreview(),
    },
  } as unknown as Host
  const e = { h, requests, most: () => most, finish: () => running.shift()?.done(), finishAll: () => { while (running.length) running.shift()?.done() } }
  engines.push(e)
  return e
}

const engines: { finishAll: () => void }[] = []
// the real clock, for a wait the fake one does not run
const realTimeout = globalThis.setTimeout

/** Waits on the real clock for `ok`, at most `ms`: what the slice does off the fake clock (reading the profile). */
async function within(ms: number, ok: () => boolean): Promise<void> {
  for (let left = ms; left > 0 && !ok(); left -= 50) await new Promise((r) => realTimeout(r, 50))
}

/** An agent's edit: the plate moves inside one agent call. */
const agentEdit = (x: number) => agentCall(async () => set({ plate: [entry(x)] }))

// The slice reads the profile first, through modules loaded on demand: load them before the clock that matters starts.
beforeAll(async () => void (await Promise.all([import('../src/state/slice-plate'), import('../src/state/profile-sync'), import('../src/adapters/profile')])))

beforeEach(() => {
  vi.useFakeTimers()
  set({ plate: [entry(10)], autoSlice: true, liveEdit: false, historyEdit: null, plateLoading: false, slice: { status: 'idle' }, resume: null, calibration: {}, layerMarks: {} })
})
afterEach(() => {
  for (const e of engines.splice(0)) e.finishAll()
  vi.useRealTimers()
})

describe('auto slice and an agent run of edits', () => {
  it('starts no slice while an agent edits, and one when its run has been quiet', async () => {
    const e = engine()
    const stop = startAutoSlice(e.h)
    for (let x = 11; x < 17; x++) {
      await agentEdit(x)
      // the gap between an agent's calls, shorter than the quiet that ends its run
      await vi.advanceTimersByTimeAsync(AGENT_QUIET_MS - 500)
    }
    // a slice started by mistake reaches the engine within this wait (it reads the profile first, off the fake clock)
    await within(3000, () => e.requests.length > 0)
    expect(e.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(600)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1), { timeout: 45_000 })
    e.finish()
    await vi.advanceTimersByTimeAsync(AGENT_QUIET_MS * 2)
    expect(e.requests).toHaveLength(1)
    stop()
  })

  it("slices a person's edit as before, a short pause after it", async () => {
    const e = engine()
    const stop = startAutoSlice(e.h)
    set({ plate: [entry(20)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1), { timeout: 45_000 })
    e.finish()
    stop()
  })

  it('starts the next slice only once a canceled one has stopped, so no two run at once', async () => {
    const e = engine()
    const stop = startAutoSlice(e.h)
    set({ plate: [entry(20)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1), { timeout: 45_000 })
    // three more edits while the engine still runs the first slice, canceled by the first of them
    for (let x = 21; x < 24; x++) {
      set({ plate: [entry(x)] })
      await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    }
    await within(3000, () => e.requests.length > 1)
    expect(e.requests).toHaveLength(1)
    // the engine stops the canceled slice: one slice starts, for the plate as it is now
    e.finish()
    await vi.waitFor(() => expect(e.requests).toHaveLength(2), { timeout: 45_000 })
    e.finish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(e.requests).toHaveLength(2)
    expect(e.most()).toBe(1)
    stop()
  })

  it('goes on without a canceled slice the engine never stops, once STUCK_SLICE_MS has passed, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = engine()
    const stop = startAutoSlice(e.h)
    set({ plate: [entry(30)] })
    await vi.advanceTimersByTimeAsync(AUTO_SLICE_DELAY_MS + 10)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1), { timeout: 45_000 })
    // an edit cancels it, and the engine never stops it
    set({ plate: [entry(31)] })
    await vi.advanceTimersByTimeAsync(STUCK_SLICE_MS - 1000)
    await within(3000, () => e.requests.length > 1)
    expect(e.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() => expect(e.requests).toHaveLength(2), { timeout: 45_000 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/canceled slice was still running in the engine after 120 s/))
    warn.mockRestore()
    stop()
  })

})
