// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry worker after a call whose engine traps: the call fails with why, and the next call runs on the engine
// loaded again, since a trapped module traps on every later call. The engine here is a stand-in over a plain memory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let loads = 0
let posted: { id?: number; result?: unknown; error?: string }[] = []

/** A stand-in engine with one operation, info; the first load's first call traps with no panic kept. */
function standIn(load: number) {
  const memory = new WebAssembly.Memory({ initial: 53 })
  const bytes = new Uint8Array(memory.buffer)
  let out = 0
  let calls = 0
  const write = (s: string) => {
    const b = new TextEncoder().encode(s)
    bytes.set(b, 1024)
    out = b.length
  }
  return {
    memory,
    geom_input: () => 64,
    geom_file: () => 0,
    geom_ops: () => (write('["info"]'), 0),
    geom_call: () => {
      if (load === 1 && calls++ === 0) throw new WebAssembly.RuntimeError('unreachable')
      write(`{"load":${load}}`)
      return 0
    },
    geom_out_ptr: () => 1024,
    geom_out_len: () => out,
    geom_error_ptr: () => 0,
    geom_error_len: () => 0,
    geom_panic_ptr: () => 0,
    geom_panic_len: () => 0,
  }
}

beforeEach(() => {
  loads = 0
  posted = []
  vi.resetModules()
  vi.stubGlobal('self', { postMessage: (m: { id?: number }) => posted.push(m) })
  vi.stubGlobal('fetch', async () => ({ ok: true }))
  // the worker names its engine files from its own module URL, which a test need not resolve
  const Url = URL
  vi.stubGlobal('URL', class extends Url {
    constructor(url: string | URL, base?: string | URL) {
      super(url, Url.canParse(url, base) ? base : 'file:///')
    }
  })
  vi.spyOn(WebAssembly, 'compileStreaming').mockResolvedValue({} as WebAssembly.Module)
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async () => ({ exports: standIn(++loads) })) as unknown as typeof WebAssembly.instantiate)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const answerTo = (id: number) => posted.find((m) => m.id === id && ('result' in m || 'error' in m))

describe('the geometry worker after a trap', () => {
  it('fails the call with why, and runs the next one on the engine loaded again', async () => {
    await import('../src/geom/geom-worker')
    const handle = (self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage
    await handle({ data: { id: 1, op: 'info', request: {} } })
    expect(answerTo(1)?.error).toBe('The geometry engine ran out of memory at 3.3 MB; try the step again')
    await handle({ data: { id: 2, op: 'info', request: {} } })
    expect(answerTo(2)?.result).toEqual({ load: 2 })
    expect(loads).toBe(2)
    // the engine loaded again answers on: no third load
    await handle({ data: { id: 3, op: 'info', request: {} } })
    expect(answerTo(3)?.result).toEqual({ load: 2 })
    expect(loads).toBe(2)
  })
})
