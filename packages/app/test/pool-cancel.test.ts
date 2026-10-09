// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A canceled browser slice stops handing out shards: the ones already running finish and are dropped, and the
// workers are free for the next slice instead of working through the canceled one.
import { describe, expect, it } from 'vitest'
import { createWasmSlicer } from '../../core/web/src/pool'

const blank = () => new ArrayBuffer(0)
const info = { layerCount: 4, layerZ: [0.2], layerTimeS: [1], stats: { filament_mm: [1], filament_g: [1], cost: 0, tool_changes: 0, time_s: 1 }, stageMicros: {}, warnings: [] }

class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly got: string[] = []
  postMessage(m: { type: string; call: number }): void {
    this.got.push(m.type)
    const send = (data: unknown) => setTimeout(() => this.onmessage?.({ data }), 2)
    if (m.type === 'init') send({ type: 'ready' })
    else if (m.type === 'slice') send({ type: 'sliced', call: m.call, info, gcode: blank(), sxpv: blank(), ms: 1 })
    else if (m.type === 'finalize') send({ type: 'finalized', call: m.call, data: blank(), format: 'gcode' })
  }
  terminate(): void {}
}

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))

describe('canceling a browser slice', () => {
  it('hands out no shard after the cancel, and the next slice runs', async () => {
    const w = new FakeWorker()
    const slicer = await createWasmSlicer({ wasm, workers: 1, warmUp: false, createWorker: () => w as unknown as Worker })
    const ac = new AbortController()
    const request = { plate: { objects: [] }, config: {}, options: { shards: 8 } } as never
    // Cancel as the first shard comes back.
    await expect(slicer.slice(request, { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 40))
    expect(w.got.filter((t) => t === 'slice')).toHaveLength(1)
    const r = await slicer.slice({ plate: { objects: [] }, config: {}, options: { shards: 2 } } as never)
    expect(r.layerCount).toBe(4)
    expect(w.got.filter((t) => t === 'slice')).toHaveLength(3)
  })

  it('a slice canceled before it starts sends nothing', async () => {
    const w = new FakeWorker()
    const slicer = await createWasmSlicer({ wasm, workers: 4, warmUp: false, createWorker: () => w as unknown as Worker })
    const ac = new AbortController()
    ac.abort()
    await expect(slicer.slice({ plate: { objects: [] }, config: {}, options: { shards: 4 } } as never, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(w.got.filter((t) => t === 'slice')).toHaveLength(0)
  })
})
