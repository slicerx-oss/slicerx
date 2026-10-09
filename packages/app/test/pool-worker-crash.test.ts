// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A slicer worker in the browser can stop after it started: an error in the module, a message it cannot read, or
// the browser killing it for memory. Calls waiting on it used to wait forever, so a slice could stay running. Now
// they fail, the worker leaves the pool, its shards go to the others, and a pool left with no worker starts a new one
// with every mesh it had.
import { describe, expect, it } from 'vitest'
import { encodeParts } from '../../core/web/src/parts'
import { createWasmSlicer } from '../../core/web/src/pool'
import { boxMesh } from '../src/plate/mesh-ops'

const blank = () => new ArrayBuffer(0)
const info = { layerCount: 4, layerZ: [0.2], layerTimeS: [1], stats: { filament_mm: [1], filament_g: [1], cost: 0, tool_changes: 0, time_s: 1 }, stageMicros: {}, warnings: [] }
const meshInfo = { id: 1, name: 'cube', triangles: 12, hash: 'h', bboxMm: [1, 1, 1], parts: [] }

type Fail = 'none' | 'error' | 'messageerror'

/** A worker that answers the pool's messages, and stops as told when it gets its first slice. */
class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly got: { type: string; meshId?: string; bytes?: number }[] = []
  terminated = false
  constructor(private readonly fail: Fail) {}
  postMessage(m: { type: string; call: number; meshId?: string; data?: ArrayBuffer }): void {
    this.got.push({ type: m.type, ...(m.meshId ? { meshId: m.meshId } : {}), ...(m.data ? { bytes: m.data.byteLength } : {}) })
    const send = (data: unknown) => setTimeout(() => this.onmessage?.({ data }), 1)
    if (m.type === 'init') send({ type: 'ready' })
    else if (m.type === 'load') send({ type: 'loaded', call: m.call, info: meshInfo })
    else if (m.type === 'parts') send({ type: 'parts', call: m.call, data: new ArrayBuffer(8) })
    else if (m.type === 'finalize') send({ type: 'finalized', call: m.call, data: blank(), format: 'gcode' })
    else if (m.type === 'slice') {
      if (this.fail === 'error') setTimeout(() => this.onerror?.({ message: 'out of memory' }), 2)
      else if (this.fail === 'messageerror') setTimeout(() => this.onmessageerror?.(), 2)
      else send({ type: 'sliced', call: m.call, info, gcode: blank(), sxpv: blank(), ms: 1 })
    }
  }
  terminate(): void {
    this.terminated = true
  }
}

const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
const request = { plate: { objects: [] }, config: {}, options: { shards: 4 } } as never

async function pool(kinds: Fail[], workers = 1) {
  const made: FakeWorker[] = []
  const slicer = await createWasmSlicer({ wasm, workers, warmUp: false, createWorker: () => (made.push(new FakeWorker(kinds[made.length] ?? 'none')), made[made.length - 1] as unknown as Worker) })
  return { slicer, made }
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e })), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))])

describe('a slicer worker that stops', () => {
  it('a slice whose only worker errors finishes on a new worker that has the same meshes', async () => {
    const { slicer, made } = await pool(['error'])
    const mesh = await slicer.loadModel(new Uint8Array([1, 2, 3, 4, 5]).buffer, 'cube.3mf')
    const r = await within(slicer.slice(request), 2000)
    expect(r).not.toBe('pending')
    expect(r !== 'pending' && r.ok).toBe(true)
    expect(made[0]!.terminated).toBe(true)
    // The new worker got the mesh as it was loaded before it took a shard.
    const loads = made[1]!.got.filter((g) => g.type === 'load')
    expect(loads).toEqual([{ type: 'load', meshId: mesh.id, bytes: 5 }])
    expect(made[1]!.got.findIndex((g) => g.type === 'slice')).toBeGreaterThan(made[1]!.got.findIndex((g) => g.type === 'load'))
  })

  it('parts are loaded again from the caller own arrays, encoded the same, with no copy kept', async () => {
    const { slicer, made } = await pool(['error'])
    const parts = [{ ...boxMesh(10, 10, 10), name: 'Body', slot: 2 }]
    const mesh = await slicer.loadParts('Body', parts)
    const r = await within(slicer.slice(request), 2000)
    expect(r !== 'pending' && r.ok).toBe(true)
    expect(made[1]!.got.filter((g) => g.type === 'load')).toEqual([{ type: 'load', meshId: mesh.id, bytes: encodeParts(parts).byteLength }])
  })

  it('a worker that cannot read its messages fails the same way', async () => {
    const { slicer, made } = await pool(['messageerror'])
    const r = await within(slicer.slice(request), 2000)
    expect(r !== 'pending' && r.ok).toBe(true)
    expect(made[0]!.terminated).toBe(true)
  })

  it('a slice fails, and does not hang, when every worker keeps stopping', async () => {
    const { slicer } = await pool(['error', 'error', 'error', 'error', 'error'])
    const r = await within(slicer.slice(request), 2000)
    expect(r).not.toBe('pending')
    expect(r !== 'pending' && !r.ok && r.e.message).toMatch(/out of memory/)
  })

  it('with four workers, the shards of one that stops go to the others', async () => {
    const { slicer, made } = await pool(['none', 'error', 'none', 'none'], 4)
    const r = await within(slicer.slice(request), 2000)
    expect(r !== 'pending' && r.ok).toBe(true)
    expect(made[1]!.terminated).toBe(true)
    const sliced = made.filter((w) => !w.terminated).reduce((n, w) => n + w.got.filter((g) => g.type === 'slice').length, 0)
    expect(sliced).toBe(4)
  })

  it('a call waiting on a worker that stops is rejected', async () => {
    const { slicer, made } = await pool(['none'])
    const mesh = await slicer.loadModel(new Uint8Array([1]).buffer, 'a.3mf')
    // The worker never answers this one: it stops instead.
    const w = made[0]!
    w.postMessage = (m: { type: string }) => void (m.type === 'parts' ? setTimeout(() => w.onerror?.({ message: 'gone' }), 2) : undefined)
    const r = await within(slicer.meshParts!(mesh.id), 500)
    expect(r !== 'pending' && !r.ok && r.e.message).toMatch(/gone/)
  })
})
