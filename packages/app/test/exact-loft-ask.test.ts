// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A new body lofted in an exact replay is asked for as an exact solid when the engine says it makes one (exact.ops
// lists sketch.loft). The replay asks which operations those are once, sends the loft with `exact: true` and its
// profiles in the part's own frame, and holds the body that comes back like any other exact part. When the engine
// makes no body the part is today's mesh loft, and the step carries the engine's sentence. An engine that lists
// nothing, or does not know the question, gets today's request unchanged.
import { beforeEach, describe, expect, it } from 'vitest'
import { IDENTITY, clearReplayCache, EXACT_LOFT_NOT_PLACED, EXACT_OPS, replayHistory, stepSalt, type History, type HistoryMesh, type Mat4, type Step, type StepParams } from '@slicerx/cad-history'

type Vec3 = [number, number, number]
interface Frame {
  origin: Vec3
  normal: Vec3
  u: Vec3
  v: Vec3
}
interface Sent {
  op: string
  req: Record<string, unknown>
}

const BED: Frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const WHY = 'These sections have curved sides, which an exact loft cannot follow yet.'
const FIRST = 2 ** 31

/**
 * An engine whose loft is a triangle per profile, on the profile's plane, so the mesh shows the frames it was sent.
 * `ops` is its answer to exact.ops (null: it does not know the question); `made` whether an exact ask gets a body.
 */
function engine(o: { ops?: string[] | null; made?: boolean } = {}) {
  const sent: Sent[] = []
  const held = new Map<number, number[]>()
  const freed: number[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    sent.push({ op, req })
    if (op === EXACT_OPS) {
      if (o.ops === null) throw new Error(`unknown operation: ${op}`)
      return { ops: o.ops ?? ['sketch.loft'] }
    }
    if (op === 'sketch.loft') {
      const positions: number[] = []
      for (const q of req['profiles'] as { frame?: Frame }[]) {
        const f = q.frame ?? BED
        positions.push(...f.origin, ...f.origin.map((c, k) => c + 10 * f.u[k]!), ...f.origin.map((c, k) => c + 10 * f.v[k]!))
      }
      const given = req['target'] as { mesh: { positions: number[]; indices: number[] } } | undefined
      const mesh = given ? given.mesh : { positions, indices: positions.map((_, i) => i).slice(0, positions.length / 3) }
      const reply = { mesh, report: { touches: true, volumeChangeMm3: 1, watertight: true } }
      if (req['exact'] !== true) return reply
      if (o.made === false) return { ...reply, exact: { made: false, why: WHY } }
      // an engine that keeps no bodies is asked for the solid's text, as the other exact steps ask
      if (req['save'] === true) return { ...reply, bodySmb: `loft-solid-${n++}` }
      if (req['withKeys'] !== true) throw new Error('sketch.loft: an exact ask says how the body comes back')
      const body = FIRST + n++
      // the faces' keys come from the step's salt alone, as the engine makes them
      const keys = [(req['keySalt'] as number) + 1, (req['keySalt'] as number) + 2]
      held.set(body, keys)
      return { ...reply, body, bodyKeys: keys }
    }
    if (op === 'brep.tessellate' && typeof req['body'] === 'object') {
      const salt = req['keySalt'] as number
      return { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2], faceIds: [0], faces: [{ id: 0, type: 'other', surface: { kind: 'other' }, key: salt + 1 }], normals: [0, 0, 0, 0, 0, 0], surfaces: [{ kind: 'spline' }], edges: [], smb: (req['body'] as { smb: string }).smb }
    }
    if (op === 'brep.tessellate') {
      const keys = held.get(req['body'] as number)
      if (!keys) throw new Error('brep: body: no such body (freed, or from an earlier session)')
      return { meshForm: 2, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 20, 10, 0, 20, 0, 10, 20]), indices: new Uint32Array([0, 1, 2, 3, 4, 5]), faceIds: new Uint32Array([0, 1]), normals: new Int16Array(12), faces: { table: [{ kind: 'plane', normal: [0, 0, -1], offset: 0 }, { kind: 'other' }], keys }, surfaces: [{ kind: 'plane' }, { kind: 'spline' }], edges: [] }
    }
    if (op === 'brep.free') {
      freed.push(req['body'] as number)
      return { freed: held.delete(req['body'] as number) }
    }
    if (op.startsWith('brep.')) throw new Error('brep: body: this operation cannot work on this body yet')
    return { mesh: req['mesh'] }
  }
  return { call, sent, held, freed, of: (op: string) => sent.filter((s) => s.op === op), ops: () => sent.map((s) => s.op) }
}

const profiles = [{ loops: [] }, { frame: { origin: [3, 4, 20], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, loops: [] }]
const loft = (id = 'loft-1', transform: Mat4 = [...IDENTITY], more: Record<string, unknown> = {}): Step => ({ id, part: 0, transform, params: { op: 'sketch.loft', profiles, operation: 'new', name: 'Hull', ...more } as StepParams })
const history = (...steps: Step[]): History => ({ version: 1, base: [], steps })
const kept = { keepsBodies: true }
// a quarter turn about Z, then a move
const PLACED: Mat4 = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 30, 40, 5, 1]
const MOVED: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 40, 0, 1]

/** The same step replayed with no exact solids at all: today's mesh loft. */
async function meshLoft(step: Step): Promise<HistoryMesh[]> {
  clearReplayCache()
  const r = await replayHistory(engine().call, { history: history(step) })
  clearReplayCache()
  return r.parts
}

// A body the test before left held is freed by the next replay that keeps bodies, through that replay's engine. The
// engines here are separate, so each test starts with those freed into one of its own that nothing reads.
beforeEach(async () => {
  clearReplayCache()
  await replayHistory(engine().call, { history: history(), exact: true }, kept)
})

describe('asking the engine for an exact loft', () => {
  it('asks once which operations are exact, sends the loft as exact and holds the body', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(loft(), { ...loft('loft-2'), part: 1 }), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'sketch.loft', 'brep.tessellate', 'brep.tessellate'])
    for (const s of e.of('sketch.loft')) {
      expect(s.req['exact']).toBe(true)
      expect(s.req['withKeys']).toBe(true)
      expect('save' in s.req).toBe(false)
      expect(s.req['operation']).toBe('new')
    }
    // the parts are the bodies' tessellations, normals and keys with them, and no solid goes out
    expect(r.parts.map((p) => p.name)).toEqual(['Hull', 'Hull'])
    for (const [i, p] of r.parts.entries()) {
      expect(p.positions).toBeInstanceOf(Float32Array)
      expect(p.normals).toBeInstanceOf(Int16Array)
      expect(p.normals).toHaveLength(p.indices.length * 2)
      expect(p.faces!.keys).toEqual([stepSalt(`loft-${i + 1}`) + 1, stepSalt(`loft-${i + 1}`) + 2])
      expect('body' in p).toBe(false)
    }
    expect(r.madeBy).toEqual({ [stepSalt('loft-1') + 1]: 'loft-1', [stepSalt('loft-1') + 2]: 'loft-1', [stepSalt('loft-2') + 1]: 'loft-2', [stepSalt('loft-2') + 2]: 'loft-2' })
    // held while a cached step has them; a warm replay asks the engine nothing new but the meshes
    expect(e.freed).toEqual([])
    await replayHistory(e.call, { history: history(loft(), { ...loft('loft-2'), part: 1 }), exact: true }, kept)
    expect(e.of(EXACT_OPS)).toHaveLength(1)
    expect(e.of('sketch.loft')).toHaveLength(2)
    // and freed once nothing holds them
    clearReplayCache()
    await replayHistory(e.call, { history: history(loft('loft-3')), exact: true }, kept)
    expect(e.freed.sort()).toEqual([FIRST, FIRST + 1])
    expect([...e.held.keys()]).toEqual([FIRST + 2])
  })

  it("carries the engine's sentence on the step when it makes no body, and the part is today's mesh loft", async () => {
    const e = engine({ made: false })
    const r = await replayHistory(e.call, { history: history(loft()), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done', note: WHY }])
    expect(r.exactFellBack).toEqual(['loft-1'])
    // with the step where it was drawn the first answer's mesh is the loft: no second call
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft'])
    expect('normals' in r.parts[0]!).toBe(false)
    expect(r.parts).toEqual(await meshLoft(loft()))
    // a warm replay says the same
    clearReplayCache()
    const cold = await replayHistory(e.call, { history: history(loft()), exact: true }, kept)
    const warm = await replayHistory(e.call, { history: history(loft()), exact: true }, kept)
    expect(warm.status).toEqual(cold.status)
    expect(warm.parts).toEqual(cold.parts)
  })

  it("sends the profiles in the part's own frame when the step is turned and moved", async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(loft('loft-1', PLACED)), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }])
    expect(e.of('sketch.loft')).toHaveLength(1)
    const asked = e.of('sketch.loft')[0]!.req
    expect(asked['exact']).toBe(true)
    const frames = (asked['profiles'] as { frame: Frame }[]).map((q) => q.frame)
    // by hand: a point p goes to R^T (p - t), a direction d to R^T d, with R's columns (0, 1, 0), (-1, 0, 0), (0, 0, 1)
    const t: Vec3 = [30, 40, 5]
    const back = (d: Vec3): Vec3 => [d[1], -d[0], d[2]]
    const want = [BED, profiles[1]!.frame as Frame].map((f) => ({ origin: back([f.origin[0] - t[0], f.origin[1] - t[1], f.origin[2] - t[2]]), normal: back(f.normal), u: back(f.u), v: back(f.v) }))
    expect(want[0]!.origin).toEqual([-40, 30, -5])
    expect(want[1]!.origin).toEqual([-36, 27, 15])
    for (const [i, f] of frames.entries()) for (const k of ['origin', 'normal', 'u', 'v'] as const) f[k].forEach((c, j) => expect(c).toBeCloseTo(want[i]![k][j]!, 12))
    // everything else about the profiles is as the step has it
    expect((asked['profiles'] as Record<string, unknown>[]).map(({ frame: _f, ...rest }) => rest)).toEqual(profiles.map(({ frame: _f, ...rest }: Record<string, unknown>) => rest))
  })

  it("falls back to exactly today's mesh loft on a step that is turned and moved", async () => {
    const e = engine({ made: false })
    const step = loft('loft-1', PLACED)
    const r = await replayHistory(e.call, { history: history(step), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done', note: WHY }])
    // the mesh loft runs as it does today: the step's own profiles, no exact ask
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'sketch.loft'])
    const again = e.of('sketch.loft')[1]!.req
    expect('exact' in again).toBe(false)
    expect(again['profiles']).toEqual(profiles)
    const today = await meshLoft(step)
    expect(r.parts).toEqual(today)
    // bit for bit
    expect(Array.from(r.parts[0]!.positions).every((v, i) => Object.is(v, today[0]!.positions[i]))).toBe(true)
    expect(Array.from(r.parts[0]!.indices)).toEqual(Array.from(today[0]!.indices))
  })

  it('gives the part the same face keys whichever frame the profiles went in', async () => {
    const here = engine()
    const a = await replayHistory(here.call, { history: history(loft()), exact: true }, kept)
    clearReplayCache()
    const there = engine()
    const b = await replayHistory(there.call, { history: history(loft('loft-1', MOVED)), exact: true }, kept)
    expect(there.of('sketch.loft')[0]!.req['profiles']).not.toEqual(here.of('sketch.loft')[0]!.req['profiles'])
    expect(there.of('sketch.loft')[0]!.req['keySalt']).toBe(here.of('sketch.loft')[0]!.req['keySalt'])
    expect(here.of('sketch.loft')[0]!.req['keySalt']).toBe(stepSalt('loft-1'))
    expect(b.parts[0]!.faces!.keys).toEqual(a.parts[0]!.faces!.keys)
    expect(b.madeBy).toEqual(a.madeBy)
  })

  it("takes the solid as text from an engine that keeps no bodies, and reads the part from it", async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(loft('loft-1', MOVED)), exact: true })
    expect(r.status).toEqual([{ state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft', 'brep.tessellate'])
    const asked = e.of('sketch.loft')[0]!.req
    expect(asked['exact']).toBe(true)
    expect(asked['save']).toBe(true)
    expect('withKeys' in asked).toBe(false)
    ;(asked['profiles'] as { frame: Frame }[])[0]!.frame.origin.forEach((c, j) => expect(c).toBeCloseTo([-30, -40, 0][j]!, 12))
    expect(e.of('brep.tessellate')[0]!.req['body']).toEqual({ smb: 'loft-solid-0' })
    expect(r.parts).toHaveLength(1)
    expect(r.parts[0]!.name).toBe('Hull')
    expect(Array.from(r.parts[0]!.normals!)).toEqual([0, 0, 0, 0, 0, 0])
    expect(r.parts[0]!.faces!.keys).toEqual([stepSalt('loft-1') + 1])
    expect('smb' in r.parts[0]!).toBe(false)
    // nothing is kept in the engine, so nothing is freed
    expect(e.of('brep.free')).toHaveLength(0)
  })

  it("an engine that keeps no bodies and makes none gets today's mesh loft, with its sentence", async () => {
    const e = engine({ made: false })
    const r = await replayHistory(e.call, { history: history(loft()), exact: true })
    expect(r.status).toEqual([{ state: 'done', note: WHY }])
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft'])
    expect(r.parts).toEqual(await meshLoft(loft()))
  })

  it('says so on a step that is stretched, and lofts on the mesh', async () => {
    const e = engine()
    const step = loft('loft-1', [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])
    const r = await replayHistory(e.call, { history: history(step), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done', note: EXACT_LOFT_NOT_PLACED }])
    expect(r.exactFellBack).toEqual(['loft-1'])
    expect(e.ops()).toEqual([EXACT_OPS, 'sketch.loft'])
    expect('exact' in e.of('sketch.loft')[0]!.req).toBe(false)
    expect(r.parts).toEqual(await meshLoft(step))
  })

  it('a mesh step on the lofted body ends its solid and its normals', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: history(loft(), { id: 'repair-1', part: 0, transform: [...IDENTITY], params: { op: 'repair' } }), exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect('normals' in r.parts[0]!).toBe(false)
    expect(Array.isArray(r.parts[0]!.positions)).toBe(true)
    expect(Array.isArray((e.of('repair')[0]!.req['mesh'] as { positions: unknown }).positions)).toBe(true)
  })
})

describe('not asking', () => {
  const unchanged = async (e: ReturnType<typeof engine>, r: Awaited<ReturnType<typeof replayHistory>>, step: Step) => {
    expect(r.status).toEqual([{ state: 'done' }])
    expect(r.exactFellBack).toBeUndefined()
    expect(e.of('sketch.loft')).toHaveLength(1)
    expect('exact' in e.of('sketch.loft')[0]!.req).toBe(false)
    expect(e.of('sketch.loft')[0]!.req['profiles']).toEqual(profiles)
    expect(r.parts).toEqual(await meshLoft(step))
  }

  it("an engine that lists no exact operations gets today's loft request", async () => {
    const e = engine({ ops: [] })
    await unchanged(e, await replayHistory(e.call, { history: history(loft('loft-1', MOVED)), exact: true }, kept), loft('loft-1', MOVED))
    expect(e.of(EXACT_OPS)).toHaveLength(1)
  })

  it('nor does one that does not know the question', async () => {
    const e = engine({ ops: null })
    await unchanged(e, await replayHistory(e.call, { history: history(loft()), exact: true }, kept), loft())
    expect(e.of(EXACT_OPS)).toHaveLength(1)
  })

  it('a replay without exact solids does not ask', async () => {
    const e = engine()
    await unchanged(e, await replayHistory(e.call, { history: history(loft()) }, kept), loft())
    expect(e.of(EXACT_OPS)).toHaveLength(0)
  })

  it('a loft joined to a part does not ask', async () => {
    const e = engine()
    const base: HistoryMesh = { name: 'Base', slot: 1, positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }
    const r = await replayHistory(e.call, { history: { version: 1, base: [base], steps: [loft('loft-1', [...IDENTITY], { operation: 'join' })] }, exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }])
    expect(e.ops()).toEqual(['sketch.loft'])
    expect('exact' in e.of('sketch.loft')[0]!.req).toBe(false)
  })
})

describe('a design that must stay exact', () => {
  const strict = (...steps: Step[]): History => ({ version: 1, base: [], steps, exact: true })

  it('takes an exact loft', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(loft()) }, kept)
    expect(r.status).toEqual([{ state: 'done' }])
    expect(r.parts[0]!.normals).toBeInstanceOf(Int16Array)
  })

  it("stops with the engine's sentence when no body was made, and never lofts on the mesh", async () => {
    const e = engine({ made: false })
    const r = await replayHistory(e.call, { history: strict(loft()) }, kept)
    expect(r.status).toEqual([{ state: 'broken', message: `Exact operation failed: ${WHY}` }])
    expect(r.parts).toEqual([])
    expect(e.of('sketch.loft')).toHaveLength(1)
  })

  it('refuses a loft as before when the engine lists none', async () => {
    const e = engine({ ops: [] })
    const r = await replayHistory(e.call, { history: strict(loft()) }, kept)
    expect(r.status[0]!.state).toBe('broken')
    expect(r.status[0]!.message).toBe('Exact replay does not support sketch.loft for this part. The mesh path was not used.')
    expect(e.of('sketch.loft')).toHaveLength(0)
  })
})
