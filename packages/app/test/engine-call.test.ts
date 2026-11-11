// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The geometry worker's engine call (geom/engine-call.ts): a mesh of typed arrays goes into the engine's memory in the
// raw form, and a mesh the engine wrote to an output buffer (`meshOutput: "raw"`) comes back as typed arrays, the same
// numbers the JSON answer gives. A call that traps says why: the panic the engine kept, or that it ran out of memory.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { callEngine, EngineTrap, rawOut, transferables, type GeomExports } from '../src/geom/engine-call'
import { liveEngine, wasmPath } from './geom-engine'

/** Exports over a plain memory, with one output buffer written at an address that is not a multiple of four. */
function fakeEngine(nv: number, nt: number, positions: number[], indices: number[]): GeomExports {
  const memory = new WebAssembly.Memory({ initial: 1 })
  const at = 1001
  const raw = new DataView(memory.buffer, at)
  raw.setUint32(0, nv, true)
  raw.setUint32(4, nt, true)
  positions.forEach((p, i) => raw.setFloat32(8 + 4 * i, p, true))
  indices.forEach((p, i) => raw.setUint32(8 + 12 * nv + 4 * i, p, true))
  const none = () => 0
  return { memory, geom_input: none, geom_file: none, geom_call: none, geom_ops: none, geom_out_ptr: none, geom_out_len: none, geom_error_ptr: none, geom_error_len: none, geom_out_files: () => 1, geom_out_file_ptr: () => at, geom_out_file_len: () => 8 + 12 * (nv + nt) }
}

describe("the engine's raw output buffers", () => {
  it('come back as typed arrays in place of rawOut, with the rest of the answer as it was', () => {
    const x = fakeEngine(4, 1, [0, 0, 0, 1.5, 0, 0, 0, 2.25, 0, 0, 0, -3], [0, 1, 2])
    const answer = rawOut(x, { objects: [{ name: 'a', parts: [{ mesh: { rawOut: 0 }, watertight: false }] }], unit: { scale: 1 } }) as {
      objects: { parts: { mesh: { positions: Float32Array; indices: Uint32Array }; watertight: boolean }[] }[]
      unit: unknown
    }
    const mesh = answer.objects[0]!.parts[0]!.mesh
    expect(mesh.positions).toBeInstanceOf(Float32Array)
    expect([...mesh.positions]).toEqual([0, 0, 0, 1.5, 0, 0, 0, 2.25, 0, 0, 0, -3])
    expect(mesh.indices).toBeInstanceOf(Uint32Array)
    expect([...mesh.indices]).toEqual([0, 1, 2])
    expect('rawOut' in mesh).toBe(false)
    expect(answer.objects[0]!.parts[0]!.watertight).toBe(false)
    expect(answer.unit).toEqual({ scale: 1 })
    // Their buffers are handed to the page, each once.
    expect(transferables(answer)).toEqual([mesh.positions.buffer, mesh.indices.buffer])
  })
})

describe.skipIf(!liveEngine)('the engine with raw output (a built engine)', () => {
  it("gives the import's meshes as the JSON answer gives them", async () => {
    const { instance } = (await WebAssembly.instantiate(readFileSync(wasmPath), {})) as unknown as { instance: WebAssembly.Instance }
    const x = instance.exports as unknown as GeomExports
    const stl = readFileSync(join(__dirname, '..', '..', 'core', 'bench', 'models', 'x-mark.stl'))
    const request = { data: { base64: stl.toString('base64') }, name: 'x-mark.stl', format: 'stl', auto: { rebuildMaxTriangles: 0 } }
    type Answer = { objects: { parts: { mesh: { positions: ArrayLike<number>; indices: ArrayLike<number>; faces?: unknown } }[] }[] }
    const flat = callEngine(x, 'import.auto', request) as Answer
    const raw = callEngine(x, 'import.auto', { ...request, meshOutput: 'raw' }) as Answer
    const plain = (a: Answer) => ({ ...a, objects: a.objects.map((o) => ({ ...o, parts: o.parts.map((p) => ({ ...p, mesh: { positions: Array.from(p.mesh.positions), indices: Array.from(p.mesh.indices), faces: p.mesh.faces } })) })) })
    expect(raw.objects[0]!.parts[0]!.mesh.positions).toBeInstanceOf(Float32Array)
    expect(plain(raw)).toEqual(plain(flat))
  })
})

describe('a call whose engine traps', () => {
  /** Exports whose call traps, keeping `panic` as the engine's panic hook does (none when empty). */
  function trappingEngine(panic: string): GeomExports {
    const memory = new WebAssembly.Memory({ initial: 53 })
    const kept = new TextEncoder().encode(panic)
    new Uint8Array(memory.buffer, 2048, kept.length).set(kept)
    const none = () => 0
    const trap = () => {
      throw new WebAssembly.RuntimeError('unreachable')
    }
    return { memory, geom_input: () => 64, geom_file: none, geom_call: trap, geom_ops: none, geom_out_ptr: none, geom_out_len: none, geom_error_ptr: none, geom_error_len: none, geom_panic_ptr: () => 2048, geom_panic_len: () => kept.length }
  }

  it('names the panic it came from', () => {
    const x = trappingEngine('panicked at packages/geom/src/boolean.rs:12:5:\nbad loop')
    expect(() => callEngine(x, 'shape.extrude', {})).toThrow(new EngineTrap('The geometry engine stopped on an internal error: panicked at packages/geom/src/boolean.rs:12:5: bad loop'))
  })

  it('says the engine ran out of memory when no panic was kept, as when its memory could not grow', () => {
    const x = trappingEngine('')
    let err: unknown
    try {
      callEngine(x, 'shape.extrude', {})
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EngineTrap)
    expect((err as Error).message).toBe('The geometry engine ran out of memory at 3.3 MB; try the step again')
  })

  it('passes on an error that is not a trap as it is', () => {
    const x = { ...trappingEngine(''), geom_call: () => { throw new TypeError('not a trap') } }
    expect(() => callEngine(x, 'info', {})).toThrow(TypeError)
  })
})
