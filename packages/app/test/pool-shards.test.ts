// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A browser slice of a plate with few layers goes out in few layer ranges: each range cuts the layers its shells
// reach again, and each worker that takes one builds the whole session.
import { describe, expect, it } from 'vitest'
import { createWasmSlicer } from '../../core/web/src/pool'
import { shardCount } from '../../core/web/src/shards'

const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const size = (s: [number, number, number]) => () => s

describe('the number of layer ranges', () => {
  it('follows the layer count on a short plate and the cap on a tall one', () => {
    const cfg = { layer_height: 0.2 }
    // 2 mm at 0.2 mm: 10 layers, 4 ranges of at least 3 layers.
    expect(shardCount([{ mesh: 'a', transform: ident }], cfg, size([50, 50, 2]), 64)).toBe(4)
    expect(shardCount([{ mesh: 'a', transform: ident }], cfg, size([50, 50, 100]), 64)).toBe(64)
    // A single layer still slices.
    expect(shardCount([{ mesh: 'a', transform: ident }], cfg, size([50, 50, 0.1]), 64)).toBe(1)
  })

  it('reads the height after the transform, and adds up objects printed one after another', () => {
    // Turned onto its side: the 50 mm side stands up.
    const side = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]
    expect(shardCount([{ mesh: 'a', transform: side }], { layer_height: 0.2 }, size([50, 50, 2]), 64)).toBe(64)
    const two = [{ mesh: 'a', transform: ident }, { mesh: 'b', transform: ident }]
    expect(shardCount(two, { layer_height: 0.2 }, size([20, 20, 2]), 64)).toBe(4)
    expect(shardCount(two, { layer_height: 0.2, print_sequence: 'by object' }, size([20, 20, 2]), 64)).toBe(7)
  })

  it('keeps the cap without a layer height or a size for every object', () => {
    expect(shardCount([{ mesh: 'a', transform: ident }], {}, size([50, 50, 2]), 64)).toBe(64)
    expect(shardCount([{ mesh: 'a', transform: ident }], { layer_height: 0.2 }, () => undefined, 64)).toBe(64)
    expect(shardCount([], { layer_height: 0.2 }, size([50, 50, 2]), 64)).toBe(64)
  })
})

class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  static sliced = 0
  postMessage(m: { type: string; call: number }): void {
    const send = (data: unknown) => setTimeout(() => this.onmessage?.({ data }), 1)
    const blank = new ArrayBuffer(0)
    const info = { layerCount: 10, layerZ: [0.2], layerTimeS: [1], stats: { filament_mm: [1], filament_g: [1], cost: 0, tool_changes: 0, time_s: 1 }, stageMicros: {}, warnings: [] }
    if (m.type === 'init') send({ type: 'ready' })
    else if (m.type === 'load') send({ type: 'loaded', call: m.call, info: { id: 1, name: 'k', triangles: 12, hash: 'h', bboxMm: [50, 50, 2], min: [0, 0, 0], max: [50, 50, 2], parts: [] } })
    else if (m.type === 'parts') send({ type: 'parts', call: m.call, data: blank })
    else if (m.type === 'slice') {
      FakeWorker.sliced++
      send({ type: 'sliced', call: m.call, info, gcode: blank, sxpv: blank, ms: 1 })
    } else if (m.type === 'finalize') send({ type: 'finalized', call: m.call, data: blank, format: 'gcode' })
  }
  terminate(): void {}
}

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))

describe('a browser slice of a short plate', () => {
  it('goes out in a few ranges', async () => {
    const slicer = await createWasmSlicer({ wasm, workers: 8, warmUp: false, createWorker: () => new FakeWorker() as unknown as Worker })
    const mesh = await slicer.loadModel(new ArrayBuffer(4), 'keychain.3mf')
    FakeWorker.sliced = 0
    await slicer.slice({ plate: { objects: [{ id: 'o', name: 'o', mesh: mesh.id, transform: ident }] }, config: { layer_height: 0.2 } } as never)
    expect(FakeWorker.sliced).toBe(4)
    // A request that names its ranges keeps them.
    FakeWorker.sliced = 0
    await slicer.slice({ plate: { objects: [{ id: 'o', name: 'o', mesh: mesh.id, transform: ident }] }, config: { layer_height: 0.2 }, options: { shards: 12 } } as never)
    expect(FakeWorker.sliced).toBe(12)
  })
})
