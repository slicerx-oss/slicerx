// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The check for faces that cross each other waits until the plate is quiet: its slice done and its fit check over. It
// runs one part at a time and ends the geometry worker after each, so the memory the check grew goes. A slice or an
// open that starts meanwhile cancels it, and it runs again once the plate is quiet.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshPart, SliceResult } from '@slicerx/contracts'
import { fitSettled } from '../src/plate/fit-state'
import { checkCrossings, crossingEngine, plateQuiet, type CrossingRunner } from '../src/state/import-auto'
import { get, set, type PlateEntry } from '../src/state/store'

const ended = vi.hoisted(() => ({ count: 0 }))
vi.mock('../src/geom/client', async (orig) => ({ ...(await orig<typeof import('../src/geom/client')>()), endIdleGeomWorker: () => (ended.count++, true) }))

const part = (n: number): MeshPart => ({ name: `p${n}`, slot: 1, positions: new Float32Array([0, 0, 0, n, 0, 0, 0, n, 0, 0, 0, n]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) })
const entry = (id: string, parts: MeshPart[]): PlateEntry => ({ id, name: id, handle: { id: `${id}#0`, hash: id, name: id, triangles: 4, bboxMm: [1, 1, 1], openEdges: 0, parts: [] }, parts, colors: parts.map(() => '#fff'), transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }) as PlateEntry
const host = { slicer: { loadParts: async () => ({ id: 'x', parts: [] }), release: () => undefined } } as unknown as Host
const done = { status: 'done', result: { id: 'r' } as SliceResult, stale: false } as const
const tick = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  set({ plate: [], toast: null, autoSlice: true, plateLoading: false, slice: { status: 'idle' } })
  ended.count = 0
})

describe('the crossing check waits for a quiet plate', () => {
  it('runs after the slice and the fit check, one part at a time', async () => {
    const [a, b] = [part(1), part(2)]
    set({ plate: [entry('o', [a, b])], slice: { status: 'running', progress: null, startedAt: 0 } })
    const order: string[] = []
    const cross: CrossingRunner = async (p) => {
      order.push(`start ${p.name}`)
      await tick()
      order.push(`end ${p.name}`)
      return { crossing: true }
    }
    const check = checkCrossings(host, 'm.stl', [{ id: 'o', perShell: true }], cross)
    await tick()
    expect(order).toEqual([])
    // The slice lands; the fit check of this plate is not over yet.
    set({ slice: done })
    await tick()
    expect(plateQuiet(get())).toBe(false)
    expect(order).toEqual([])
    fitSettled(get().plate)
    expect(await check).toEqual({ fixed: 0, left: 2 })
    expect(order).toEqual(['start p1', 'end p1', 'start p2', 'end p2'])
    expect(get().toast?.text).toBe('m.stl: 2 parts still cross themselves (too large to rebuild during import).')
  })

  it('is canceled by a slice that starts, and runs again when the plate is quiet', async () => {
    const a = part(1)
    set({ plate: [entry('o', [a])], slice: done })
    fitSettled(get().plate)
    const calls: AbortSignal[] = []
    const cross: CrossingRunner = (_p, _s, signal) => {
      calls.push(signal!)
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')))
        if (calls.length > 1) setTimeout(() => resolve({ crossing: true }), 5)
      })
    }
    const check = checkCrossings(host, 'm.stl', [{ id: 'o', perShell: true }], cross)
    await tick()
    expect(calls).toHaveLength(1)
    // The person slices again: the check stops, and waits for that slice.
    set({ slice: { status: 'running', progress: null, startedAt: 0 } })
    expect(calls[0]!.aborted).toBe(true)
    await tick()
    expect(calls).toHaveLength(1)
    set({ slice: done })
    expect(await check).toEqual({ fixed: 0, left: 1 })
    expect(calls).toHaveLength(2)
  })

  it('is canceled by an open that starts', async () => {
    set({ plate: [entry('o', [part(1)])], slice: done })
    fitSettled(get().plate)
    let signal: AbortSignal | undefined
    const check = checkCrossings(host, 'm.stl', [{ id: 'o', perShell: true }], (_p, _s, sig) => {
      signal ??= sig
      return new Promise((resolve, reject) => {
        sig?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')))
        if (sig !== signal) resolve({ crossing: false })
      })
    })
    await tick()
    set({ plateLoading: true })
    expect(signal?.aborted).toBe(true)
    set({ plateLoading: false })
    expect(await check).toEqual({ fixed: 0, left: 0 })
  })

  it("ends the geometry worker after each part's check", async () => {
    const { setGeomProvider } = await import('../src/geom/client')
    setGeomProvider({ call: async <T,>() => ({ crossing: false }) as T })
    await crossingEngine(part(1), true)
    await crossingEngine(part(2), true)
    expect(ended.count).toBe(2)
    setGeomProvider(null)
  })
})
