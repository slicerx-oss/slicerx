// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry worker after a call whose engine traps. A trapped module traps on every later call, so the worker loads
// the engine again. A call that ran out of memory (no panic kept) is tried once more on it and the retry is logged; a
// panic is not tried again, and a retry that traps too fails with why. The engine here is a stand-in over a plain
// memory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let loads = 0
let posted: { id?: number; result?: unknown; error?: string }[] = []
/** What the stand-in's call does on a load and call number: answer, run out of memory, or panic with this text. */
let plan: (load: number, call: number) => string = () => 'answer'

function standIn(load: number) {
  const memory = new WebAssembly.Memory({ initial: 53 })
  const bytes = new Uint8Array(memory.buffer)
  let out = 0
  let panic = 0
  let calls = 0
  const write = (s: string, at: number) => {
    const b = new TextEncoder().encode(s)
    bytes.set(b, at)
    return b.length
  }
  return {
    memory,
    geom_input: () => 64,
    geom_file: () => 0,
    geom_ops: () => ((out = write('["info"]', 1024)), 0),
    geom_call: () => {
      const what = plan(load, calls++)
      if (what !== 'answer') {
        if (what !== 'memory') panic = write(what, 2048)
        throw new WebAssembly.RuntimeError('unreachable')
      }
      out = write(`{"load":${load}}`, 1024)
      return 0
    },
    geom_out_ptr: () => 1024,
    geom_out_len: () => out,
    geom_error_ptr: () => 0,
    geom_error_len: () => 0,
    geom_panic_ptr: () => 2048,
    geom_panic_len: () => panic,
  }
}

const OUT_OF_MEMORY = 'The geometry engine ran out of memory at 3.3 MB; try the step again'
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  loads = 0
  posted = []
  plan = () => 'answer'
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
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const answerTo = (id: number) => posted.find((m) => m.id === id && ('result' in m || 'error' in m))

async function worker() {
  await import('../src/geom/geom-worker')
  const handle = (self as unknown as { onmessage: (e: { data: unknown }) => Promise<void> }).onmessage
  return (id: number) => handle({ data: { id, op: 'info', request: {} } })
}

describe('the geometry worker after a trap', () => {
  it('tries a call that ran out of memory once more on the engine loaded again, and logs it', async () => {
    plan = (load, call) => (load === 1 && call === 0 ? 'memory' : 'answer')
    const send = await worker()
    await send(1)
    expect(answerTo(1)).toMatchObject({ result: { load: 2 } })
    expect(loads).toBe(2)
    expect(warn).toHaveBeenCalledWith(`sx-geom info: ${OUT_OF_MEMORY}; trying it once more on a fresh engine`)
    // the engine loaded again answers on: no third load
    await send(2)
    expect(answerTo(2)).toMatchObject({ result: { load: 2 } })
    expect(loads).toBe(2)
  })

  it('names the panic a call stopped on, does not try it again, and runs the next call on the engine loaded again', async () => {
    plan = (load, call) => (load === 1 && call === 0 ? 'panicked at src/boolean.rs:12:5:\nbad loop' : 'answer')
    const send = await worker()
    await send(1)
    expect(answerTo(1)?.error).toBe('The geometry engine stopped on an internal error: panicked at src/boolean.rs:12:5: bad loop')
    expect(loads).toBe(1)
    expect(warn).not.toHaveBeenCalled()
    await send(2)
    expect(answerTo(2)).toMatchObject({ result: { load: 2 } })
  })

  it('says why when the retry runs out of memory too', async () => {
    plan = (load, call) => (load <= 2 && call === 0 ? 'memory' : 'answer')
    const send = await worker()
    await send(1)
    expect(answerTo(1)?.error).toBe(OUT_OF_MEMORY)
    expect(loads).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    await send(2)
    expect(answerTo(2)).toMatchObject({ result: { load: 3 } })
  })
})
