// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ bytes: 0, loads: 0 }))
// the engine with exact solids, as its exports: a memory of state.bytes (replaced when it grows, as a wasm memory's
// buffer is) that answers {} to every call and an error to brep.fail
vi.mock('../src/geom/exact-engine', () => ({
  loadExactExports: async () => {
    state.loads++
    let buffer = new ArrayBuffer(0)
    let op = ''
    const at = { out: 0, error: 16, ops: 40, input: 64 }
    const reply = { out: new TextEncoder().encode('{}'), error: new TextEncoder().encode('{"error":"failed"}'), ops: new TextEncoder().encode('[]') }
    const memory = {
      get buffer() {
        if (buffer.byteLength !== state.bytes) {
          buffer = new ArrayBuffer(state.bytes)
          new Uint8Array(buffer).set(reply.out, at.out)
          new Uint8Array(buffer).set(reply.error, at.error)
          new Uint8Array(buffer).set(reply.ops, at.ops)
        }
        return buffer
      },
    }
    return {
      memory,
      geom_input: () => at.input,
      geom_call: () => {
        const bytes = new Uint8Array(memory.buffer, at.input, 32)
        op = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)))
        return op === 'brep.fail' ? 1 : 0
      },
      geom_ops: () => 0,
      geom_out_ptr: () => (op === '' ? at.ops : at.out),
      geom_out_len: () => (op === '' ? reply.ops.length : reply.out.length),
      geom_error_ptr: () => at.error,
      geom_error_len: () => reply.error.length,
    }
  },
}))
vi.mock('../src/geom/modules', () => ({
  engineModules: (_core: unknown, _full: unknown, _err: unknown, loadExact: () => Promise<{ call(op: string, r: unknown): unknown }>) => {
    let exact: Promise<{ call(op: string, r: unknown): unknown }> | null = null
    const plain = { operations: new Set(), call: () => ({}) }
    const module = async (op: string) => (op.startsWith('brep.') ? (exact ??= loadExact()) : plain)
    return { run: async (op: string, r: unknown) => (await module(op)).call(op, r), module, core: async () => true, full: async () => true }
  },
}))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules() })

it('reports the lazy exact heap after growth and on error replies', async () => {
  const postMessage = vi.fn()
  const worker = { postMessage, onmessage: null as null | ((e: unknown) => Promise<void>) }
  vi.stubGlobal('self', worker)
  await import('../src/geom/geom-worker')
  const send = async (op: string) => { await worker.onmessage!({ data: { id: 1, op, request: {} } }); return postMessage.mock.lastCall![0] as { memoryBytes: number; error?: string } }
  expect(await send('mesh.info')).toMatchObject({ result: {}, memoryBytes: 0 })
  expect(state.loads).toBe(0)
  state.bytes = 16 * 1024 * 1024
  expect((await send('brep.count')).memoryBytes).toBe(state.bytes)
  state.bytes = 300 * 1024 * 1024
  expect(await send('brep.fail')).toMatchObject({ error: 'failed', memoryBytes: state.bytes })
  const last = await send('mesh.info')
  expect(last).toMatchObject({ result: {}, memoryBytes: state.bytes })
  expect(last.error).toBeUndefined()
  expect(state.loads).toBe(1)
})

it.each([[256 * 1024 * 1024, 30_000], [300 * 1024 * 1024, 2_000]])('recycles an exact worker holding %i bytes after %i ms', async (memoryBytes, idleMs) => {
  vi.useFakeTimers()
  const workers: { terminate: ReturnType<typeof vi.fn>; onmessage?: (e: unknown) => void; postMessage: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('Worker', class {
    terminate = vi.fn()
    onmessage?: (e: unknown) => void
    postMessage = vi.fn((r: { id: number }) => { this.onmessage?.({ data: { id: r.id, result: {}, memoryBytes } }) })
    constructor() { workers.push(this) }
  })
  const { geom, setGeomProvider, endIdleGeomWorker } = await import('../src/geom/client')
  setGeomProvider(null)
  await geom().call('history.replay', { history: { version: 2, base: [], steps: [] }, exact: true })
  await vi.advanceTimersByTimeAsync(idleMs! - 1)
  expect(workers[0]!.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  await geom().call('history.replay', { history: { version: 2, base: [], steps: [] }, exact: true })
  expect(workers).toHaveLength(2)
  expect(workers[1]!.postMessage.mock.calls[0]![0].op).toBe('history.replay')
  endIdleGeomWorker()
  setGeomProvider(null)
})
