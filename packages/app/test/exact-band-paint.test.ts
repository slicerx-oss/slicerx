// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A height band painted on an exact part goes on whole faces, so it lasts through the part's later exact steps as
// paint by face does (exact-rules.test.ts). A face that crosses the band's edge is split there first by the kernel
// (brep.imprint, which leaves the shape as it is), and paint the face had goes on every piece. A band whose edges
// fall where faces already meet needs no split. An engine that cannot split faces leaves the band on the triangles,
// as before: a design that must stay exact refuses it, and anywhere else the next exact step clears it with its note.
import { beforeEach, describe, expect, it } from 'vitest'
import { EXACT_IMPRINT, EXACT_OPS, IDENTITY, PAINT_DROPPED, clearReplayCache, replayHistory, stepSalt, type History, type HistoryMesh, type Mat4, type Step, type StepParams } from '@slicerx/cad-history'

type Vec3 = [number, number, number]
/** A face of a stand-in body: its key, and the heights it runs between (a flat face has both the same). */
interface Face {
  key: number
  lo: number
  hi: number
}
interface Sent {
  op: string
  req: Record<string, unknown>
}

const FIRST = 2 ** 31
const kept = { keepsBodies: true }
const REFUSED = 'brep: imprint: the kernel could not split the faces (status 1001)'

/**
 * An engine whose kernel holds bodies by number, each a list of faces. Each face tessellates as two triangles, 10 mm
 * apart along X: upright from its low height to its high one, or flat at its height. brep.imprint splits every face a
 * plane crosses into a piece below and a piece above, each with a new key from the step's salt, and names each piece's
 * face in `split`. `imprint: false` is an engine without it; `refuse` one whose kernel fails it.
 */
function engine(o: { imprint?: boolean; refuse?: boolean } = {}) {
  const sent: Sent[] = []
  const held = new Map<number, Face[]>()
  let n = 0
  const hold = (faces: Face[]) => {
    const body = FIRST + n++
    held.set(body, faces)
    return { body, bodyKeys: faces.map((f) => f.key) }
  }
  const facesOf = (b: unknown): Face[] => {
    const f = typeof b === 'number' ? held.get(b) : undefined
    if (!f) throw new Error('brep: body: no such body (freed, or from an earlier session)')
    return f
  }
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    sent.push({ op, req })
    const salt = req['keySalt'] as number
    switch (op) {
      case EXACT_OPS:
        return { ops: ['sketch.loft', ...(o.imprint === false ? [] : [EXACT_IMPRINT])] }
      case 'sketch.loft':
        // a hull: its bottom at 0, one side from 0 to 20, its deck at 20
        return { mesh: { positions: [], indices: [] }, report: { watertight: true }, ...hold([{ key: salt + 1, lo: 0, hi: 0 }, { key: salt + 2, lo: 0, hi: 20 }, { key: salt + 3, lo: 20, hi: 20 }]) }
      case EXACT_IMPRINT: {
        if (o.refuse) throw new Error(REFUSED)
        let faces = facesOf(req['body'])
        const split: [number, number][] = []
        let k = 0
        for (const p of req['planes'] as { origin: Vec3; normal: Vec3 }[]) {
          const h = p.origin[2]
          faces = faces.flatMap((f) => {
            if (!(f.lo < h && f.hi > h)) return [f]
            const pieces = [{ key: salt + 50 + k++, lo: f.lo, hi: h }, { key: salt + 50 + k++, lo: h, hi: f.hi }]
            for (const x of pieces) split.push([x.key, split.find(([key]) => key === f.key)?.[1] ?? f.key])
            return pieces
          })
        }
        return { ...hold(faces), split }
      }
      case 'brep.subtract':
        // the faces keep their keys; the hole's wall is a new face with the step's
        return hold([...facesOf(req['body']), { key: salt + 100, lo: 5, hi: 15 }])
      case 'brep.tessellate': {
        const faces = facesOf(req['body'])
        const positions: number[] = []
        faces.forEach((f, i) => {
          const x = 10 * i
          const quad = f.lo === f.hi ? [[x, 0, f.lo], [x + 5, 0, f.lo], [x + 5, 5, f.lo], [x, 5, f.lo]] : [[x, 0, f.lo], [x + 5, 0, f.lo], [x + 5, 0, f.hi], [x, 0, f.hi]]
          for (const c of [0, 1, 2, 0, 2, 3]) positions.push(...quad[c]!)
        })
        const t = faces.length * 2
        return { meshForm: 2, positions: new Float32Array(positions), indices: Uint32Array.from({ length: t * 3 }, (_, i) => i), faceIds: Uint32Array.from({ length: t }, (_, i) => Math.floor(i / 2)), normals: new Int16Array(t * 6), faces: { table: faces.map(() => ({ kind: 'plane' })), keys: faces.map((f) => f.key) }, surfaces: [], edges: [] }
      }
      case 'brep.free':
        return { freed: held.delete(req['body'] as number) }
      case 'paint.select': {
        // a whole part takes the state's text on every triangle; a height band, as the mesh path paints it, splits a
        // triangle it crosses, so each one it crosses gets a text of its own
        const mesh = req['mesh'] as { positions: number[]; indices: number[] }
        const target = req['target'] as { kind: string; below?: number }
        const changed: Record<string, string> = {}
        for (let t = 0; t < mesh.indices.length / 3; t++) {
          if (target.kind === 'part') changed[t] = `S${req['state']}`
          else if (target.kind === 'height') {
            const z = [0, 1, 2].map((c) => mesh.positions[3 * mesh.indices[3 * t + c]! + 2]!)
            if (Math.max(...z) <= target.below!) changed[t] = `S${req['state']}`
            else if (Math.min(...z) < target.below!) changed[t] = `P${req['state']}-${t}`
          }
        }
        return { changed }
      }
    }
    if (op.startsWith('brep.')) throw new Error(`brep: ${op} is not in this engine`)
    return { mesh: req['mesh'] }
  }
  return { call, sent, held, of: (op: string) => sent.filter((s) => s.op === op) }
}

const frame = (z: number) => ({ origin: [0, 0, z] as Vec3, normal: [0, 0, 1] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3 })
const hull = (transform: Mat4 = [...IDENTITY]): Step => ({ id: 'hull', part: 0, transform, params: { op: 'sketch.loft', profiles: [{ frame: frame(0), loops: [] }, { frame: frame(20), loops: [] }], operation: 'new', name: 'Hull' } as StepParams })
const step = (id: string, params: StepParams, transform: Mat4 = [...IDENTITY]): Step => ({ id, part: 0, transform, params })
const band = (id: string, target: Record<string, number>, state = 2, transform?: Mat4) => step(id, { op: 'paint', layer: 'color', state, target: { kind: 'height', ...target } } as StepParams, transform)
const whole = (id: string, state = 1) => step(id, { op: 'paint', layer: 'color', state, target: { kind: 'part' } } as StepParams)
const hole = step('hole', { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 10], axis: [0, 1, 0], diameterMm: 2, heightMm: 40 }], label: 'Hole' } as StepParams)
const strict = (...steps: Step[]): History => ({ version: 1, base: [], steps, exact: true })
const salt = (id: string) => stepSalt(id)

/** Each face's key and the text its triangles have (the two of a face always agree on a part painted by face). */
function paintByKey(p: HistoryMesh | undefined): Record<number, string> {
  const out: Record<number, string> = {}
  const keys = p!.faces!.keys!
  const ids = Array.from(p!.faces!.ids)
  ids.forEach((id, t) => {
    const text = p!.paint?.color?.[t]
    if (text === undefined) return
    expect(out[keys[id]!] ?? text).toBe(text)
    out[keys[id]!] = text
  })
  return out
}

/** Whether the part came from a held body's tessellation: its own normals and its faces' keys. */
const exactPart = (p: HistoryMesh | undefined) => expect(p?.normals).toBeInstanceOf(Int16Array)

beforeEach(async () => {
  clearReplayCache()
  await replayHistory(engine().call, { history: strict() }, kept)
})

describe('a height band on an exact part', () => {
  it('splits the side the band crosses at its edge and paints the faces below it, in a design that must stay exact', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(hull(), band('red', { below: 4 })) }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    exactPart(r.parts[0])
    // one call, one plane at the band's edge, in the part's frame
    expect(e.of(EXACT_IMPRINT)).toHaveLength(1)
    expect(e.of(EXACT_IMPRINT)[0]!.req['planes']).toEqual([{ origin: [0, 0, 4], normal: [0, 0, 1] }])
    // the bottom and the side's piece below the edge; the piece above and the deck stay bare
    const red = salt('red')
    expect(r.parts[0]!.faces!.keys).toEqual([salt('hull') + 1, red + 50, red + 51, salt('hull') + 3])
    expect(paintByKey(r.parts[0])).toEqual({ [salt('hull') + 1]: 'S2', [red + 50]: 'S2' })
  })

  it('keeps the band through a later exact step, by its faces', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(hull(), band('red', { below: 4 }), hole) }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    expect(e.of('brep.subtract')).toHaveLength(1)
    exactPart(r.parts[0])
    const red = salt('red')
    expect(paintByKey(r.parts[0])).toEqual({ [salt('hull') + 1]: 'S2', [red + 50]: 'S2' })
  })

  it('needs no split where its edges fall on edges the faces already have', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(hull(), band('lower', { from: 0, to: 20 }, 3)) }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }])
    expect(e.of(EXACT_IMPRINT)).toHaveLength(0)
    const h = salt('hull')
    expect(paintByKey(r.parts[0])).toEqual({ [h + 1]: 'S3', [h + 2]: 'S3', [h + 3]: 'S3' })
  })

  it('between two heights, splits at both in one call and paints the strake between them', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(hull(), band('strake', { from: 12, to: 8 }, 4)) }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(e.of(EXACT_IMPRINT)[0]!.req['planes']).toEqual([{ origin: [0, 0, 8], normal: [0, 0, 1] }, { origin: [0, 0, 12], normal: [0, 0, 1] }])
    const k = salt('strake')
    // the side in three: below 8, 8 to 12, above 12; only the middle one is painted
    expect(r.parts[0]!.faces!.keys).toEqual([salt('hull') + 1, k + 50, k + 52, k + 53, salt('hull') + 3])
    expect(paintByKey(r.parts[0])).toEqual({ [k + 52]: 'S4' })
  })

  it('measures heights on the bed: a raised part is split where the band meets it, in its own frame', async () => {
    const up: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(hull(up), band('red', { below: 9 }, 2, up)) }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(e.of(EXACT_IMPRINT)[0]!.req['planes']).toEqual([{ origin: [0, 0, 4], normal: [0, 0, 1] }])
  })

  it('puts paint the split face had on every piece of it', async () => {
    const e = engine()
    const r = await replayHistory(e.call, { history: strict(hull(), whole('white', 1), band('red', { below: 4 })) }, kept)
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
    const h = salt('hull')
    const red = salt('red')
    expect(paintByKey(r.parts[0])).toEqual({ [h + 1]: 'S2', [red + 50]: 'S2', [red + 51]: 'S1', [h + 3]: 'S1' })
  })

  it("breaks the step with the kernel's words when it cannot split the faces", async () => {
    const r = await replayHistory(engine({ refuse: true }).call, { history: strict(hull(), band('red', { below: 4 })) }, kept)
    expect(r.status[1]).toEqual({ state: 'broken', message: 'The kernel could not split the faces (status 1001)' })
  })
})

describe('a height band on an engine that cannot split faces', () => {
  it('is refused in a design that must stay exact, as before', async () => {
    const e = engine({ imprint: false })
    const r = await replayHistory(e.call, { history: strict(hull(), band('red', { below: 4 })) }, kept)
    expect(r.status[1]).toEqual({ state: 'broken', message: 'Exact replay does not support paint for this part. The mesh path was not used.' })
    expect(e.of(EXACT_IMPRINT)).toHaveLength(0)
  })

  it('stays on the triangles anywhere else, and the next exact step clears it with the paint note', async () => {
    const e = engine({ imprint: false })
    const r = await replayHistory(e.call, { history: { version: 1, base: [], steps: [hull(), band('red', { below: 4 }), hole] }, exact: true }, kept)
    expect(r.status).toEqual([{ state: 'done' }, { state: 'done' }, { state: 'done', note: PAINT_DROPPED }])
    expect(r.parts[0]!.paint).toBeUndefined()
  })
})
