// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The integrator wrapper (packages/geom/wasm/geom.mjs) after a call that stops the engine: it says why, never keeps the
// stopped module, tries a call that ran out of memory once more on a fresh one (logged), and does not try a panic
// again. The engine here is a stand-in over a plain memory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGeom, type GeomTrap } from '../../geom/wasm/geom.mjs'

let made = 0
/** What the stand-in's call does on a module and call number: answer, run out of memory, or panic with this text. */
let plan: (module: number, call: number) => string = () => 'answer'

function standIn(n: number) {
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
    geom_ops: () => ((out = write('["info"]', 1024)), 0),
    geom_call: () => {
      const what = plan(n, calls++)
      if (what !== 'answer') {
        if (what !== 'memory') panic = write(what, 2048)
        throw new WebAssembly.RuntimeError('unreachable')
      }
      out = write(`{"module":${n}}`, 1024)
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

const OUT_OF_MEMORY = 'the engine ran out of memory at 3.3 MB; try the step again'
const module = {} as WebAssembly.Module

beforeEach(() => {
  made = 0
  plan = () => 'answer'
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async () => ({ exports: standIn(++made) })) as unknown as typeof WebAssembly.instantiate)
  vi.spyOn(WebAssembly, 'Instance').mockImplementation(function () {
    return { exports: standIn(++made) }
  } as unknown as typeof WebAssembly.Instance)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('geom.mjs after a call that stops the engine', () => {
  it('tries a call that ran out of memory once more on a fresh module, and logs it', async () => {
    plan = (n, call) => (n === 1 && call === 0 ? 'memory' : 'answer')
    const log: string[] = []
    const geom = await createGeom(module, { log: (line) => log.push(line) })
    expect(geom.call('info', {})).toEqual({ module: 2 })
    expect(log).toEqual([`sx-geom info: ${OUT_OF_MEMORY}; trying it once more on a fresh engine`])
    expect(geom.call('info', {})).toEqual({ module: 2 })
    expect(made).toBe(2)
  })

  it('names the panic a call stopped on, does not try it again, and runs the next call on a fresh module', async () => {
    plan = (n, call) => (n === 1 && call === 0 ? 'panicked at src/boolean.rs:12:5:\nbad loop' : 'answer')
    const log: string[] = []
    const geom = await createGeom(module, { log: (line) => log.push(line) })
    let err: GeomTrap | undefined
    try {
      geom.call('info', {})
    } catch (e) {
      err = e as GeomTrap
    }
    expect(err?.message).toBe('the engine stopped on an internal error: panicked at src/boolean.rs:12:5: bad loop')
    expect(err).toMatchObject({ trapped: true, outOfMemory: false })
    expect(log).toEqual([])
    expect(made).toBe(1)
    expect(geom.call('info', {})).toEqual({ module: 2 })
  })

  it('says why when the retry runs out of memory too, and the next call gets a fresh module', async () => {
    plan = (n, call) => (n <= 2 && call === 0 ? 'memory' : 'answer')
    const log: string[] = []
    const geom = await createGeom(module, { log: (line) => log.push(line) })
    expect(() => geom.call('info', {})).toThrow(OUT_OF_MEMORY)
    expect(log).toHaveLength(1)
    expect(geom.call('info', {})).toEqual({ module: 3 })
  })

  it('does not try a nest session step again', async () => {
    plan = (n, call) => (n === 1 && call === 0 ? 'memory' : 'answer')
    const log: string[] = []
    const geom = await createGeom(module, { log: (line) => log.push(line) })
    expect(() => geom.call('nest.step', { session: 1 })).toThrow(OUT_OF_MEMORY)
    expect(log).toEqual([])
  })
})
