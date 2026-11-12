// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The native geometry provider (native-provider.ts): frames, meshes as raw buffers both ways, one call at a time, cancel
// and time limits that end the engine process, a crash that fails only its call, body numbers that never reach a
// process that did not make them, and the idle end. A stand-in engine answers here; with SLICERX_GEOM_SERVE_BIN (a
// build of the engine's serve loop, packages/geom/src/serve.rs) the same provider also runs the real engine in a
// process of its own, and SX_NATIVE_BENCH=1 prints its times.
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearReplayCache, HISTORY_VERSION, replayHistory, type EngineCall, type History, type StepParams } from '@slicerx/cad-history'
import type { MeshPart } from '@slicerx/contracts'
import { CANCEL_GRACE_MS, IDLE_MS, setGeomProvider, usesWorker } from '../src/geom/client'
import { decodeFrame, encodeFrame, EngineEnded, nativeProvider, type NativeEngine } from '../src/geom/native-provider'
import { withStep } from '../src/cad/history/record'
import { boxMesh } from '../src/plate/mesh-ops'
import { liveEngine, wasmGeom } from './geom-engine'

afterEach(() => {
  vi.useRealTimers()
  setGeomProvider(null)
  clearReplayCache()
})

/** An answer frame as the engine writes it. */
const answerFrame = (answer: unknown, buffers: Uint8Array[] = []) => encodeFrame(JSON.stringify(answer), buffers)

/**
 * A stand-in engine process: `answer` gives each call's answer (or a promise of it, for a call that runs a while). It
 * keeps what reached it, and its process number goes up each time it is ended and called again.
 */
function standIn(answer: (op: string, request: Record<string, unknown>, buffers: Uint8Array[]) => unknown) {
  const seen: { op: string; request: Record<string, unknown>; buffers: Uint8Array[]; generation: number }[] = []
  let generation = 0
  let alive = false
  let crash: (() => void) | null = null
  const engine: NativeEngine = {
    async call(frame) {
      if (!alive) {
        alive = true
        generation++
      }
      const from = generation
      const { answer: call, buffers } = decodeFrame(frame)
      const op = call['op'] as string
      const request = call['request'] as Record<string, unknown>
      seen.push({ op, request, buffers: buffers.map((b) => b.slice()), generation: from })
      const ended = new Promise<never>((_, reject) => {
        crash = () => reject(new EngineEnded(null))
      })
      const out = (await Promise.race([Promise.resolve(answer(op, request, buffers)), ended])) as { frame?: Uint8Array } | unknown
      crash = null
      const f = out !== null && typeof out === 'object' && 'frame' in out ? (out as { frame: Uint8Array }).frame : answerFrame({ id: call['id'], result: out })
      return { generation: from, frame: f }
    },
    async end() {
      alive = false
      crash?.()
    },
  }
  return { engine, seen, generation: () => generation }
}

/** A promise and its resolve, for a call that runs until the test says. */
function later<T = unknown>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('frames', () => {
  it('carry a JSON text and its buffers', () => {
    const f = encodeFrame('{"id":1}', [new Uint8Array([1, 2, 3]), new Uint8Array(0)])
    const { answer, buffers } = decodeFrame(f)
    expect(answer).toEqual({ id: 1 })
    expect(buffers.map((b) => [...b])).toEqual([[1, 2, 3], []])
  })
})

describe('native provider', () => {
  it('runs the worker jobs, so the app hands it what it hands the worker', async () => {
    const { engine } = standIn(() => ({}))
    setGeomProvider(nativeProvider(engine))
    expect(usesWorker()).toBe(true)
    const p = nativeProvider(engine)
    await expect(p.call('engine.full', null)).resolves.toBe(true)
  })

  it('sends a mesh of typed arrays as a raw buffer and reads raw output back as typed arrays', async () => {
    const { engine, seen } = standIn((_op, _r, buffers) => {
      const raw = buffers[0]!
      return { frame: answerFrame({ id: 1, result: { mesh: { rawOut: 0 }, report: { ok: true } } }, [raw]) }
    })
    const p = nativeProvider(engine)
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    const r = await p.call<{ mesh: { positions: Float32Array; indices: Uint32Array }; report: unknown }>('repair', { mesh: { positions, indices }, meshOutput: 'raw' })
    expect(seen[0]!.request).toEqual({ mesh: { rawPath: 'mem:0' }, meshOutput: 'raw', withFaces: true })
    expect(seen[0]!.buffers[0]!.length).toBe(8 + 12 * 3 + 12)
    expect(r.mesh.positions).toBeInstanceOf(Float32Array)
    expect([...r.mesh.positions]).toEqual([...positions])
    expect([...r.mesh.indices]).toEqual([...indices])
    expect(r.report).toEqual({ ok: true })
  })

  it('sends a project as its bytes and other files as base64, as the worker does', async () => {
    const { engine, seen } = standIn(() => ({}))
    const p = nativeProvider(engine)
    await p.call('format.read3mf', { data: { bytes: new Uint8Array([80, 75]) } })
    await p.call('import.auto', { data: { bytes: new Uint8Array([104, 105]) }, name: 'a.stl' })
    expect(seen[0]!.request).toEqual({ data: { path: 'mem:0' }, withFaces: true })
    expect([...seen[0]!.buffers[0]!]).toEqual([80, 75])
    expect(seen[1]!.request).toEqual({ data: { base64: 'aGk=' }, name: 'a.stl', withFaces: true })
  })

  it('runs calls one at a time, in order', async () => {
    const first = later()
    const { engine, seen } = standIn((op) => (op === 'one' ? first.promise : { op }))
    const p = nativeProvider(engine)
    const a = p.call('one', {})
    const b = p.call('two', {})
    await new Promise((r) => setTimeout(r, 10))
    expect(seen.map((s) => s.op)).toEqual(['one'])
    first.resolve({ op: 'one' })
    expect(await a).toEqual({ op: 'one' })
    expect(await b).toEqual({ op: 'two' })
    expect(seen.map((s) => s.op)).toEqual(['one', 'two'])
  })

  it('never runs a call canceled while it waits', async () => {
    const first = later()
    const { engine, seen } = standIn((op) => (op === 'one' ? first.promise : {}))
    const p = nativeProvider(engine)
    const a = p.call('one', {})
    const stop = new AbortController()
    const b = p.call('two', {}, stop.signal)
    stop.abort()
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    first.resolve({})
    await a
    await new Promise((r) => setTimeout(r, 10))
    expect(seen.map((s) => s.op)).toEqual(['one'])
  })

  it('ends the engine process when a canceled call is still running after the grace time', async () => {
    const stuck = later()
    const { engine, seen, generation } = standIn((op) => (op === 'slow' ? stuck.promise : { op }))
    const p = nativeProvider(engine)
    const stop = new AbortController()
    const slow = p.call('slow', {}, stop.signal)
    await new Promise((r) => setTimeout(r, 10))
    stop.abort()
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' })
    expect(generation()).toBe(1)
    await new Promise((r) => setTimeout(r, CANCEL_GRACE_MS + 50))
    // the next call runs in a new process
    expect(await p.call('next', {})).toEqual({ op: 'next' })
    expect(seen.at(-1)!.generation).toBe(2)
  })

  it('refuses a call past its time limit with the worker words and ends its process', async () => {
    const { engine, seen } = standIn((op) => (op === 'slow' ? new Promise(() => {}) : { op }))
    const p = nativeProvider(engine, { limit: () => 50 })
    await expect(p.call('slow', {})).rejects.toThrow(/past its 0\.1 s limit/)
    expect(await p.call('next', {})).toEqual({ op: 'next' })
    expect(seen.map((s) => s.generation)).toEqual([1, 2])
  })

  it('fails only the running call when the engine process crashes', async () => {
    let crashed = false
    const s = standIn((op) => {
      if (op === 'crash') {
        crashed = true
        void s.engine.end()
        return new Promise(() => {})
      }
      return { op }
    })
    const p = nativeProvider(s.engine)
    await expect(p.call('crash', {})).rejects.toThrow('The geometry engine stopped on an internal error: the engine process ended')
    expect(crashed).toBe(true)
    expect(await p.call('next', {})).toEqual({ op: 'next' })
  })

  it('gives a panic and a failure in the worker words', async () => {
    const { engine } = standIn((op) =>
      op === 'brep.box' ? { body: 1 } : { frame: answerFrame(op === 'panics' ? { id: 1, panic: 'boom at serve.rs:1:1' } : { id: 1, error: 'brep: no such body' }) },
    )
    const p = nativeProvider(engine)
    await expect(p.call('panics', {})).rejects.toThrow('The geometry engine stopped on an internal error: boom at serve.rs:1:1')
    // the kernel's message, without the native engine's name for it, as the worker's kernel gives it
    const { body } = await p.call<{ body: number }>('brep.box', {})
    await expect(p.call('brep.info', { body })).rejects.toThrow(/^no such body$/)
  })

  it('names each body by the process that made it and never sends it to another', async () => {
    const { engine, seen } = standIn((op, r) => (op === 'brep.box' ? { body: 3 } : op === 'brep.free' ? { freed: true } : { body: r['body'] }))
    const p = nativeProvider(engine)
    const { body } = await p.call<{ body: number }>('brep.box', { min: [0, 0, 0], max: [1, 1, 1] })
    expect(body).toBe(2 ** 32 + 3)
    await p.call('brep.info', { body })
    expect(seen[1]!.request).toEqual({ body: 3 })
    await engine.end()
    // a new process: the old body is gone with its process
    await p.call('brep.count', {})
    await expect(p.call('brep.free', { body })).resolves.toEqual({ freed: false })
    await expect(p.call('brep.info', { body })).rejects.toThrow(/interrupted/)
    expect(seen.map((s) => s.op)).toEqual(['brep.box', 'brep.info', 'brep.count'])
  })

  it('ends the engine process after IDLE_MS with nothing to do', async () => {
    vi.useFakeTimers()
    const { engine, seen } = standIn((op) => ({ op }))
    const end = vi.spyOn(engine, 'end')
    const p = nativeProvider(engine)
    const a = p.call('one', {})
    await vi.advanceTimersByTimeAsync(0)
    await a
    expect(end).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(end).toHaveBeenCalledTimes(1)
    const b = p.call('two', {})
    await vi.advanceTimersByTimeAsync(0)
    await b
    expect(seen.map((s) => s.generation)).toEqual([1, 2])
  })

  it('replays a history in TypeScript with its engine calls going to the engine', async () => {
    const { engine } = standIn(() => ({}))
    const p = nativeProvider(engine)
    const r = await p.call<{ parts: unknown[]; status: unknown[] }>('history.replay', { history: { version: HISTORY_VERSION, base: [], steps: [] } })
    expect(r.parts).toEqual([])
    expect(r.status).toEqual([])
  })
})

// --- a solid's triangles: the mesh and the three buffers beside it (packages/geom/src/exact.rs, tessellate)

const FIRST = 2 ** 31

/** A frame as `answerFrame` makes it, its text padded so the buffers start `shift` bytes past a multiple of four. */
function shiftedFrame(answer: unknown, buffers: Uint8Array[], shift: number): Uint8Array {
  const text = JSON.stringify(answer)
  for (let pad = 0; pad < 4; pad++) {
    const f = encodeFrame(text + ' '.repeat(pad), buffers)
    if (decodeFrame(f).buffers.every((b) => b.byteOffset % 4 === shift)) return f
  }
  throw new Error('no padding lines the buffers up')
}

const le = (a: Int16Array | Uint32Array | Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

/** Two triangles of a held body: the raw mesh, packed normals, a face per triangle and an edge's points, as exact.rs writes them. */
function solidBuffers(o: { normals?: number; faceIds?: number } = {}) {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 20, 10, 0, 20, 0, 10, 20])
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5])
  const raw = new Uint8Array(8 + positions.byteLength + indices.byteLength)
  new DataView(raw.buffer).setUint32(0, 6, true)
  new DataView(raw.buffer).setUint32(4, 2, true)
  raw.set(le(positions), 8)
  raw.set(le(indices), 8 + positions.byteLength)
  const normals = Int16Array.from({ length: o.normals ?? 12 }, (_, i) => (i % 2 ? -32767 : i * 1000))
  const faceIds = Uint32Array.from({ length: o.faceIds ?? 2 }, (_, i) => i)
  const edgePoints = new Uint32Array([0, 1])
  return { positions, indices, normals, faceIds, buffers: [raw, le(normals), le(faceIds), le(edgePoints)] }
}

/** The answer's text for those buffers, numbered in that order. */
const solidAnswer = (keys = [7, 8]) => ({
  meshForm: 2,
  rawOut: 0,
  normalsOut: 1,
  faceIdsOut: 2,
  edgePointsOut: 3,
  faces: { table: [{ kind: 'plane', normal: [0, 0, -1], offset: 0 }, { kind: 'other' }], keys },
  surfaces: [{ kind: 'plane' }, { kind: 'spline' }],
  edges: [{ faces: [0, 1], curve: 'line', tangent: false, points: 2 }],
})

type Solid = { positions: Float32Array; indices: Uint32Array; normals?: Int16Array; faceIds?: Uint32Array } & Record<string, unknown>

describe("native provider: a solid's triangles", () => {
  it('asks the engine for them as buffers, and only them', async () => {
    const { engine, seen } = standIn((op) => (op === 'brep.box' ? { body: FIRST } : {}))
    const p = nativeProvider(engine)
    const { body } = await p.call<{ body: number }>('brep.box', {})
    await p.call('brep.tessellate', { body, chordMm: 0.05 })
    await p.call('brep.tessellate', { body: { smb: 'text' } })
    await p.call('brep.tessellate', { body, meshOutput: 'flat' })
    await p.call('brep.info', { body })
    expect(seen.map((s) => s.request)).toEqual([{}, { body: FIRST, chordMm: 0.05, meshOutput: 'raw' }, { body: { smb: 'text' }, meshOutput: 'raw' }, { body: FIRST, meshOutput: 'flat' }, { body: FIRST }])
  })

  it('hands the normals over as an Int16Array and the face ids as a Uint32Array, beside the mesh', async () => {
    const s = solidBuffers()
    const { engine } = standIn(() => ({ frame: answerFrame({ id: 1, result: solidAnswer() }, s.buffers) }))
    const r = await nativeProvider(engine).call<Solid>('brep.tessellate', { body: { smb: 'solid' } })
    expect(r.positions).toBeInstanceOf(Float32Array)
    expect([...r.positions]).toEqual([...s.positions])
    expect([...r.indices]).toEqual([...s.indices])
    expect(r.normals).toBeInstanceOf(Int16Array)
    expect([...r.normals!]).toEqual([...s.normals])
    expect(r.faceIds).toBeInstanceOf(Uint32Array)
    expect([...r.faceIds!]).toEqual([0, 1])
    // the buffer numbers they came under are gone; the rest of the answer is as the engine wrote it
    const { positions: _p, indices: _i, normals: _n, faceIds: _f, ...rest } = r
    const { rawOut: _r, normalsOut: _no, faceIdsOut: _fo, ...given } = solidAnswer()
    expect(rest).toEqual(given)
  })

  it('reads them in place, without a copy, when the frame has them lined up', async () => {
    const s = solidBuffers()
    let frame: Uint8Array | undefined
    const { engine } = standIn(() => ({ frame: (frame = shiftedFrame({ id: 1, result: solidAnswer() }, s.buffers, 0)) }))
    const r = await nativeProvider(engine).call<Solid>('brep.tessellate', { body: { smb: 'solid' } })
    expect(r.normals!.buffer).toBe(frame!.buffer)
    expect(r.faceIds!.buffer).toBe(frame!.buffer)
    expect([...r.normals!]).toEqual([...s.normals])
    expect([...r.faceIds!]).toEqual([0, 1])
  })

  it('reads them right when the frame has them out of line', async () => {
    for (const shift of [1, 2, 3]) {
      const s = solidBuffers()
      const { engine } = standIn(() => ({ frame: shiftedFrame({ id: 1, result: solidAnswer() }, s.buffers, shift) }))
      const r = await nativeProvider(engine).call<Solid>('brep.tessellate', { body: { smb: 'solid' } })
      expect([...r.normals!], `shift ${shift}`).toEqual([...s.normals])
      expect([...r.faceIds!], `shift ${shift}`).toEqual([0, 1])
    }
  })

  it('drops normals or face ids that are not one set for each triangle', async () => {
    const cases: { o: { normals?: number; faceIds?: number }; normals: boolean; faceIds: boolean }[] = [
      { o: { normals: 10 }, normals: false, faceIds: true },
      { o: { normals: 18 }, normals: false, faceIds: true },
      { o: { faceIds: 1 }, normals: true, faceIds: false },
      { o: { faceIds: 3 }, normals: true, faceIds: false },
      { o: { normals: 0, faceIds: 0 }, normals: false, faceIds: false },
    ]
    for (const c of cases) {
      const s = solidBuffers(c.o)
      const { engine } = standIn(() => ({ frame: answerFrame({ id: 1, result: solidAnswer() }, s.buffers) }))
      const r = await nativeProvider(engine).call<Solid>('brep.tessellate', { body: { smb: 'solid' } })
      const what = JSON.stringify(c.o)
      expect('normals' in r, what).toBe(c.normals)
      expect('faceIds' in r, what).toBe(c.faceIds)
      expect('normalsOut' in r || 'faceIdsOut' in r, what).toBe(false)
      expect(r.indices.length, what).toBe(6)
    }
    // a buffer that is not a whole number of values
    const s = solidBuffers()
    const bad = [s.buffers[0]!, s.buffers[1]!.subarray(1), s.buffers[2]!.subarray(0, 7), s.buffers[3]!]
    const { engine } = standIn(() => ({ frame: answerFrame({ id: 1, result: solidAnswer() }, bad) }))
    const r = await nativeProvider(engine).call<Solid>('brep.tessellate', { body: { smb: 'solid' } })
    expect('normals' in r || 'faceIds' in r).toBe(false)
  })

  it('refuses an answer that names a buffer it did not send', async () => {
    const s = solidBuffers()
    const { engine } = standIn(() => ({ frame: answerFrame({ id: 1, result: { ...solidAnswer(), faceIdsOut: 9 } }, s.buffers) }))
    await expect(nativeProvider(engine).call('brep.tessellate', { body: { smb: 'solid' } })).rejects.toThrow('The geometry engine named a buffer it did not send: 9')
  })

  it('leaves a mesh answer without them as it was, field for field and in order', async () => {
    const s = solidBuffers()
    const answer = { mesh: { rawOut: 0, faces: { ids: [0, 0], table: [{ kind: 'other' }] } }, report: { ok: true } }
    const { engine } = standIn(() => ({ frame: answerFrame({ id: 1, result: answer }, [s.buffers[0]!]) }))
    const r = await nativeProvider(engine).call<{ mesh: Record<string, unknown>; report: unknown }>('repair', { mesh: { positions: s.positions, indices: s.indices } })
    expect(Object.keys(r)).toEqual(['mesh', 'report'])
    expect(Object.keys(r.mesh)).toEqual(['faces', 'positions', 'indices'])
    expect(r.mesh['faces']).toEqual(answer.mesh.faces)
    expect([...(r.mesh['positions'] as Float32Array)]).toEqual([...s.positions])
    expect([...(r.mesh['indices'] as Uint32Array)]).toEqual([...s.indices])
  })

  it('gives an exact loft its true normals and faces through a whole replay', async () => {
    const s = solidBuffers()
    const sent: { op: string; request: Record<string, unknown> }[] = []
    const { engine } = standIn((op, request) => {
      sent.push({ op, request })
      if (op === 'exact.ops') return { ops: ['sketch.loft'] }
      if (op === 'sketch.loft') return { mesh: { positions: [], indices: [] }, report: { watertight: true }, body: FIRST, bodyKeys: [7, 8] }
      if (op === 'brep.tessellate') return { frame: answerFrame({ id: 1, result: solidAnswer() }, s.buffers) }
      if (op === 'brep.free') return { freed: true }
      throw new Error(`unexpected ${op}`)
    })
    const p = nativeProvider(engine)
    const profiles = [{ loops: [] }, { frame: { origin: [0, 0, 20], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [] }]
    const step = { id: 'loft-1', part: 0, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], params: { op: 'sketch.loft', profiles, operation: 'new', name: 'Hull' } }
    const r = await p.call<{ parts: { name: string; positions: ArrayLike<number>; indices: ArrayLike<number>; normals?: Int16Array; faces?: { ids: ArrayLike<number>; table: unknown[]; keys?: number[] } }[]; status: unknown[] }>('history.replay', { history: { version: HISTORY_VERSION, base: [], steps: [step] }, exact: true })
    expect(r.status).toEqual([{ state: 'done' }])
    expect(sent.map((x) => x.op)).toEqual(['exact.ops', 'sketch.loft', 'brep.tessellate'])
    // the body goes back to the engine as the number it gave, and its triangles are asked for as buffers
    expect(sent[2]!.request).toMatchObject({ body: FIRST, meshOutput: 'raw' })
    const [part] = r.parts
    expect(part!.name).toBe('Hull')
    expect(part!.positions).toBeInstanceOf(Float32Array)
    expect(part!.normals).toBeInstanceOf(Int16Array)
    expect([...part!.normals!]).toEqual([...s.normals])
    expect(Array.from(part!.faces!.ids)).toEqual([0, 1])
    expect(part!.faces!.table).toEqual(solidAnswer().faces.table)
    expect(part!.faces!.keys).toEqual([7, 8])
  })
})

// --- the real engine in a process of its own

const serveBin = process.env['SLICERX_GEOM_SERVE_BIN']
const serveArgs = JSON.parse(process.env['SLICERX_GEOM_SERVE_ARGS'] ?? '[]') as string[]
const HELLO = Buffer.from('SXGEOM1\n')

/** The engine's serve loop as a process, the way the desktop app runs it, with the time each call took. */
function processEngine(): NativeEngine & { times: { op: string; ms: number }[]; pid(): number | undefined } {
  let child: ChildProcess | null = null
  let generation = 0
  let held: Buffer = Buffer.alloc(0)
  let hello = false
  let waiting: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void } | null = null
  const times: { op: string; ms: number }[] = []
  const take = () => {
    if (!hello) {
      const at = held.indexOf(HELLO)
      if (at < 0) return
      held = held.subarray(at + HELLO.length)
      hello = true
    }
    if (!waiting || held.length < 4) return
    let at = 4 + held.readUInt32LE(0)
    if (held.length < at + 4) return
    const n = held.readUInt32LE(at)
    at += 4
    for (let i = 0; i < n; i++) {
      if (held.length < at + 4) return
      at += 4 + held.readUInt32LE(at)
    }
    if (held.length < at) return
    const frame = new Uint8Array(held.subarray(0, at))
    held = held.subarray(at)
    const w = waiting
    waiting = null
    w.resolve(frame)
  }
  const start = () => {
    const c = spawn(serveBin!, serveArgs, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, SX_GEOM_SERVE_CHILD: 'plain' } })
    generation++
    held = Buffer.alloc(0)
    hello = false
    c.stdout!.on('data', (d: Buffer) => {
      held = held.length ? Buffer.concat([held, d]) : d
      take()
    })
    c.on('exit', (code) => {
      if (child === c) child = null
      waiting?.reject(new EngineEnded(code))
      waiting = null
    })
    return c
  }
  return {
    times,
    pid: () => child?.pid,
    call(frame) {
      child ??= start()
      const from = generation
      const op = decodeFrame(frame).answer['op'] as string
      const t = performance.now()
      return new Promise((resolve, reject) => {
        waiting = { resolve: (f) => (times.push({ op, ms: performance.now() - t }), resolve({ generation: from, frame: f })), reject }
        child!.stdin!.write(frame)
      })
    },
    async end() {
      const c = child
      child = null
      c?.kill()
    },
  }
}

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const top = (z: number) => ({ origin: [100, 100, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] })

/** A 80 by 40 by 6 mm bracket foot with `n` steps: holes, bosses and a pull every few steps (cad-history-bench.test.ts). */
function bracket(n: number): History {
  let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [boxMesh(80, 40, 6)], transform: T }
  let pulls = 0
  for (let i = 0; i < n; i++) {
    const x = -36 + (i % 10) * 8
    const y = -16 + (Math.floor(i / 10) % 5) * 8
    let params: StepParams
    if (i % 5 === 4) params = { op: 'face.push', at: [140 + pulls++, 100, 3], normal: [1, 0, 0], distanceMm: 1 }
    else if (i % 2 === 0) params = { op: 'shape.extrude', frame: top(6), shape: { type: 'circle', diameterMm: 3 }, placement: { center: [x, y] }, spec: { distanceMm: 4, operation: 'cut' } }
    else params = { op: 'shape.extrude', frame: top(6), shape: { type: 'rectangle', widthMm: 4, heightMm: 3, cornerRadiusMm: 1 }, placement: { center: [x, y] }, spec: { distanceMm: 3, operation: 'join' } }
    e = { ...e, history: withStep(e, 0, params) }
  }
  return e.history!
}

type Replayed = { parts: { positions: ArrayLike<number>; indices: ArrayLike<number> }[]; status: { state: string }[] }

describe.skipIf(!serveBin)('native provider on the real engine', () => {
  it('answers a mesh call as the in-process engine does', async () => {
    const engine = processEngine()
    const p = nativeProvider(engine)
    try {
      const box = boxMesh(20, 10, 5)
      const r = await p.call<{ mesh: { positions: Float32Array; indices: Uint32Array }; report: { watertight: boolean } }>('repair', { mesh: { positions: box.positions, indices: box.indices }, meshOutput: 'raw' })
      expect(r.report.watertight).toBe(true)
      expect(r.mesh.indices.length).toBe(box.indices.length)
      await expect(p.call('no.such.op', {})).rejects.toThrow(/no\.such\.op/)
    } finally {
      await engine.end()
    }
  })

  it('replays a 20 step design with the same result as the WebAssembly engine', async () => {
    const engine = processEngine()
    const p = nativeProvider(engine)
    try {
      const h = bracket(20)
      const native = await p.call<Replayed>('history.replay', { history: h })
      expect(native.status.every((s) => s.state === 'done')).toBe(true)
      if (!liveEngine) return
      clearReplayCache()
      const g = await wasmGeom()
      const call: EngineCall = (op, r) => g.call(op, r)
      const wasm = (await replayHistory(call, { history: h })) as unknown as Replayed
      expect(native.parts.length).toBe(wasm.parts.length)
      for (const [i, part] of native.parts.entries()) {
        expect(Array.from(part.indices)).toEqual(Array.from(wasm.parts[i]!.indices))
        expect(Array.from(part.positions)).toEqual(Array.from(wasm.parts[i]!.positions))
      }
    } finally {
      await engine.end()
    }
  }, 120_000)

  it.skipIf(process.env['SX_NATIVE_KERNEL'] !== '1')('leaves no kernel body behind once the replays are dropped', async () => {
    const engine = processEngine()
    const p = nativeProvider(engine)
    try {
      for (let i = 0; i < 40; i++) {
        let e: { parts: MeshPart[]; transform: number[]; history?: History } = { parts: [], transform: T, history: { version: HISTORY_VERSION, base: [], steps: [], exact: true } }
        e = { ...e, history: withStep(e, 0, { op: 'shape.extrude', frame: top(0), shape: { type: 'rectangle', widthMm: 30 + i, heightMm: 10 }, placement: { center: [0, 0] }, spec: { distanceMm: 3, operation: 'new' } }, T, true) }
        e = { ...e, history: withStep(e, 0, { op: 'shape.extrude', frame: top(3), shape: { type: 'circle', diameterMm: 3 }, placement: { center: [5, 0] }, spec: { distanceMm: 3, operation: 'cut' } }, T, true) }
        const r = await p.call<Replayed>('history.replay', { history: e.history, exact: true })
        expect(r.status.every((s) => s.state === 'done'), JSON.stringify(r.status)).toBe(true)
      }
      const held = await p.call<{ bodies: number }>('brep.count', {})
      expect(held.bodies).toBeGreaterThan(0)
      // the design goes: what the page kept goes, and the next replay frees the bodies it held
      clearReplayCache()
      await p.call('history.replay', { history: { version: HISTORY_VERSION, base: [], steps: [], exact: true }, exact: true })
      expect(await p.call('brep.count', {})).toEqual({ bodies: 0 })
    } finally {
      await engine.end()
    }
  }, 120_000)

  it.skipIf(process.env['SX_NATIVE_BENCH'] !== '1')('times a replay and a million-triangle call', async () => {
    const engine = processEngine()
    const p = nativeProvider(engine)
    const rows: string[] = []
    try {
      for (const n of [5, 20, 50]) {
        const h = bracket(n)
        clearReplayCache()
        await p.call('history.replay', { history: h })
        clearReplayCache()
        engine.times.length = 0
        const t = performance.now()
        await p.call('history.replay', { history: h })
        const total = performance.now() - t
        const inEngine = engine.times.reduce((s, x) => s + x.ms, 0)
        rows.push(`native replay of ${n} steps: ${total.toFixed(0)} ms, ${(total / n).toFixed(1)} ms a step, ${inEngine.toFixed(0)} ms waiting on ${engine.times.length} engine calls, ${(total - inEngine).toFixed(0)} ms on this thread`)
        if (liveEngine) {
          const g = await wasmGeom()
          const call: EngineCall = (op, r) => g.call(op, r)
          clearReplayCache()
          await replayHistory(call, { history: h })
          clearReplayCache()
          const w = performance.now()
          await replayHistory(call, { history: h })
          const wasm = performance.now() - w
          rows.push(`WebAssembly replay of ${n} steps in process: ${wasm.toFixed(0)} ms, ${(wasm / n).toFixed(1)} ms a step`)
        }
      }
      // about a million triangles: a grid of 708 by 708 squares
      const g = 708
      const positions = new Float32Array((g + 1) * (g + 1) * 3)
      for (let y = 0, k = 0; y <= g; y++) for (let x = 0; x <= g; x++, k += 3) positions.set([x * 0.1, y * 0.1, ((x * 7 + y * 13) % 5) * 0.01], k)
      const indices = new Uint32Array(g * g * 6)
      for (let y = 0, k = 0; y < g; y++) for (let x = 0; x < g; x++, k += 6) {
        const a = y * (g + 1) + x
        indices.set([a, a + 1, a + g + 2, a, a + g + 2, a + g + 1], k)
      }
      for (const op of ['info', 'repair']) {
        const ms: number[] = []
        for (let i = 0; i < 5; i++) {
          const t = performance.now()
          await p.call(op, { mesh: { positions, indices }, ...(op === 'repair' ? { meshOutput: 'raw' } : {}) })
          ms.push(performance.now() - t)
        }
        ms.sort((a, b) => a - b)
        rows.push(`${op} of ${indices.length / 3} triangles through the provider and the pipe: ${ms[2]!.toFixed(0)} ms (median of 5)`)
      }
    } finally {
      await engine.end()
    }
    console.log(rows.join('\n'))
  }, 600_000)
})
