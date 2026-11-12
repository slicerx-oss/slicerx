// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A pattern of steps on a curved part, where some copies miss it: the copies that land are kept, the ones that miss
// are left out whole and named in the step's note, and the step breaks only when none land. On the mesh and on exact
// solids alike, and on a row that follows a curved side past the end of the body, with stand-in engines.
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, copiesLanded, EXACT_FELL_BACK, IDENTITY, NO_COPY_LANDS, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'

const tri = (mark: number) => ({ positions: [mark, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] })
type R = Record<string, unknown>

/**
 * A mesh engine: each subtract or join answers a new mesh marked with a running number in its first coordinate, and
 * misses (nothing removed, or no touch) when `misses` says so for the request's moved x (the transform's x shift) and
 * whether the transform mirrors it.
 */
function meshEngine(misses: (x: number, op: string, mirrored: boolean) => boolean) {
  const seen: { op: string; x: number; from: number }[] = []
  let n = 100
  const call = async (op: string, request: unknown) => {
    const req = request as R
    const item = (req['mesh'] ?? req['target']) as { mesh: { positions: number[] }; transform: number[] } | undefined
    const x = item?.transform?.[12] ?? 0
    const mirrored = (item?.transform?.[0] ?? 1) < 0
    seen.push({ op, x, from: item?.mesh.positions[0] ?? -1 })
    if (op === 'subtract') return misses(x, op, mirrored) ? { mesh: tri(0), removedVolumeMm3: 0 } : { mesh: tri(++n), removedVolumeMm3: 5 }
    if (op === 'shape.extrude') return misses(x, op, mirrored) ? { mesh: tri(0), report: { touches: false } } : { mesh: tri(++n), report: { touches: true } }
    return { mesh: tri(++n), report: { touches: true } }
  }
  return { call, seen }
}

const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
const hull: History['base'] = [{ name: 'Hull', slot: 1, ...tri(1) }]
const hole = step('hole-1', { op: 'subtract', solids: [{ type: 'cylinder', origin: [0, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole 4 mm' } as StepParams)
const row = (count: number, steps = ['hole-1']) => step('row-1', { op: 'pattern', steps, spec: { kind: 'linear', count, step: [6, 0, 0] } })
const history = (...steps: Step[]): History => ({ version: 1, base: hull, steps })
// copy k of a row 6 mm apart moves the part back by 6 (k - 1) mm, so the hole lands 6 (k - 1) mm along
const copyAt = (x: number) => Math.round(-x / 6) + 1

beforeEach(() => clearReplayCache())

describe('the note and result a pattern of steps gives', () => {
  it('keeps every copy when none miss, with no note', () => {
    expect(copiesLanded([2, 3, 4], [])).toEqual({ kept: [2, 3, 4], missed: [], note: null, broken: null, known: true })
  })
  it('names one copy, several, and runs of three or more', () => {
    expect(copiesLanded([2, 3, 4], [3]).note).toBe('Copy 3 did not reach the part and was left out.')
    expect(copiesLanded([2, 3, 4, 5], [2, 4])).toEqual({ kept: [3, 5], missed: [2, 4], note: 'Copies 2 and 4 did not reach the part and were left out.', broken: null, known: true })
    const many = Array.from({ length: 40 }, (_, k) => k + 2)
    expect(copiesLanded(many, [2, 3, 4, 5, 9, 30, 31, 32, 33]).note).toBe('Copies 2 to 5, 9 and 30 to 33 did not reach the part and were left out.')
  })
  it('breaks when no copy lands, except inside a copy of an outer pattern', () => {
    expect(copiesLanded([2, 3], [2, 3])).toEqual({ kept: [], missed: [2, 3], note: null, broken: NO_COPY_LANDS, known: true })
    expect(copiesLanded([2, 3], [2, 3], 2)).toEqual({ kept: [], missed: [2, 3], note: 'In copy 2, copies 2 and 3 did not reach the part and were left out.', broken: null, known: true })
  })
  it('keeps every copy, with no note, when the engine does not say which missed', () => {
    expect(copiesLanded([2, 3], null)).toEqual({ kept: [2, 3], missed: [], note: null, broken: null, known: false })
  })
})

describe('a pattern of steps on the mesh', () => {
  it('keeps the copies that land and names the ones that miss', async () => {
    const e = meshEngine((x) => [2, 4].includes(copyAt(x)))
    const r = await replayHistory(e.call, { history: history(hole, row(5)) })
    expect(r.status[1]).toEqual({ state: 'done', note: 'Copies 2 and 4 did not reach the part and were left out.', copies: { total: 5, kept: 3, missed: [2, 4] } })
    // every copy was tried, and each kept one cut the part the copy before it left
    expect(e.seen.filter((s) => s.op === 'subtract').map((s) => copyAt(s.x))).toEqual([1, 2, 3, 4, 5])
  })

  it('leaves a copy out whole: a later step of it that misses takes back the earlier one', async () => {
    const boss = step('boss-1', { op: 'shape.extrude', frame: { origin: [0, 0, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'circle', diameterMm: 2 }, spec: { distanceMm: 1, operation: 'join' } } as StepParams)
    // copy 3's hole lands and its boss misses
    const e = meshEngine((x, op) => op === 'shape.extrude' && copyAt(x) === 3)
    const r = await replayHistory(e.call, { history: history(hole, boss, row(4, ['hole-1', 'boss-1'])) })
    expect(r.status[2]).toEqual({ state: 'done', note: 'Copy 3 did not reach the part and was left out.', copies: { total: 4, kept: 3, missed: [3] } })
    const calls = e.seen.filter((s) => s.op === 'subtract' || s.op === 'shape.extrude')
    const copy3Hole = calls.find((s) => s.op === 'subtract' && copyAt(s.x) === 3)!
    const copy4Hole = calls.find((s) => s.op === 'subtract' && copyAt(s.x) === 4)!
    // copy 4 starts from the part as copy 3 found it, not from copy 3's hole
    expect(copy4Hole.from).toBe(copy3Hole.from)
  })

  it('breaks when no copy reaches the part', async () => {
    const e = meshEngine((x) => copyAt(x) > 1)
    const r = await replayHistory(e.call, { history: history(hole, row(3)) })
    expect(r.status[1]).toEqual({ state: 'broken', message: NO_COPY_LANDS })
  })

  it('runs as before when every copy lands', async () => {
    const e = meshEngine(() => false)
    const r = await replayHistory(e.call, { history: history(hole, row(4)) })
    expect(r.status[1]).toEqual({ state: 'done', copies: { total: 4, kept: 4, missed: [] } })
  })

  it('still breaks on a copy that fails for another reason, naming it', async () => {
    const e = meshEngine(() => false)
    const call = async (op: string, request: unknown) => {
      const x = ((request as R)['mesh'] as { transform: number[] } | undefined)?.transform?.[12] ?? 0
      if (op === 'subtract' && copyAt(x) === 3) throw new Error('The cut needs a closed part.')
      return e.call(op, request)
    }
    const r = await replayHistory(call, { history: history(hole, row(4)) })
    expect(r.status[1]?.state).toBe('broken')
    expect(r.status[1]?.message).toMatch(/^Copy 3: /)
  })

  it('names the misses of a row inside a mirrored copy by the copy they are in', async () => {
    const both = step('both-1', { op: 'pattern', steps: ['row-1'], spec: { kind: 'mirror', plane: { point: [20, 0, 0], normal: [1, 0, 0] } } })
    // the mirrored row is sent turned, at 40, 34 and 28 mm: its copy 3 misses there, while the row itself lands
    const e = meshEngine((x, _op, mirrored) => mirrored && x === 28)
    const r = await replayHistory(e.call, { history: history(hole, row(3), both) })
    expect(r.status[1]).toEqual({ state: 'done', copies: { total: 3, kept: 3, missed: [] } })
    // the mirror's own two copies both landed; the miss inside its copy 2 is in the note only
    expect(r.status[2]).toEqual({ state: 'done', note: 'In copy 2, copy 3 did not reach the part and was left out.', copies: { total: 2, kept: 2, missed: [] } })
  })
})

/** A closed body turned about x through rings at each x in `xs` with radius r(x), as positions and indices. */
function lathe(xs: readonly number[], r: (x: number) => number, n = 48): { positions: number[]; indices: number[] } {
  const positions: number[] = []
  for (const x of xs) for (let k = 0; k < n; k++) positions.push(x, r(x) * Math.cos((2 * Math.PI * k) / n), r(x) * Math.sin((2 * Math.PI * k) / n))
  const indices: number[] = []
  for (let j = 0; j + 1 < xs.length; j++)
    for (let k = 0; k < n; k++) {
      const [a, b, c, d] = [j * n + k, (j + 1) * n + k, (j + 1) * n + ((k + 1) % n), j * n + ((k + 1) % n)]
      indices.push(a, b, c, a, c, d)
    }
  const last = (xs.length - 1) * n
  for (let k = 1; k + 1 < n; k++) indices.push(0, k + 1, k, last, last + k, last + k + 1)
  return { positions, indices }
}

describe('a row that follows a curved side', () => {
  // a pod 50 mm long whose radius curves from 10 at x 0 to 5 at x 50, and a slit cut into its top at x 10
  const pod = lathe(Array.from({ length: 41 }, (_, k) => k * 1.25), (x) => 10 - (x * x) / 500)
  const top = 10 - 100 / 500
  const slit = step('slit-1', { op: 'subtract', solids: [{ type: 'box', min: [9, -1, top - 1], max: [11, 1, top] }], label: 'Slit' } as StepParams)
  const along = (count: number) => step('row-1', { op: 'pattern', steps: ['slit-1'], spec: { kind: 'linear', count, step: [15, 0, 0], onSurface: true } })
  /** An engine whose cuts take a little and leave the part's shape as it was, so the row follows the pod itself. */
  function podEngine() {
    const cuts: number[][] = []
    const call = async (op: string, request: unknown) => {
      const item = (request as R)['mesh'] as { mesh: { positions: number[]; indices: number[] }; transform: number[] }
      if (op === 'subtract') cuts.push(item.transform)
      return { mesh: { positions: Array.from(item.mesh.positions), indices: Array.from(item.mesh.indices) }, removedVolumeMm3: 2 }
    }
    return { call, cuts }
  }

  it('keeps the copies that land on the side and names the ones past the end of the body', async () => {
    const e = podEngine()
    // copies at x 25 and 40 are on the pod; at x 55 and 70 they are past its end
    const r = await replayHistory(e.call, { history: { version: 1, base: [{ name: 'Pod', slot: 1, ...pod }], steps: [slit, along(5)] } })
    expect(r.status[1]).toEqual({ state: 'done', note: 'Copies 4 and 5 did not reach the part and were left out.', copies: { total: 5, kept: 3, missed: [4, 5] } })
    // the slit itself and the two copies that landed, and no cut for the ones past the end
    expect(e.cuts).toHaveLength(3)
  })

  it('breaks when every copy runs past the end', async () => {
    const e = podEngine()
    const r = await replayHistory(e.call, { history: { version: 1, base: [{ name: 'Pod', slot: 1, ...pod }], steps: [slit, step('row-1', { op: 'pattern', steps: ['slit-1'], spec: { kind: 'linear', count: 3, step: [45, 0, 0], onSurface: true } })] } })
    expect(r.status[1]).toEqual({ state: 'broken', message: NO_COPY_LANDS })
    expect(e.cuts).toHaveLength(1)
  })
})

/**
 * An exact engine that misses with the copies `misses` names: a brep.extrude cut of one copy (found by its frame's x
 * origin, `copyOf`) answers touches false; a cut of every copy's outline at once (a row on an exact solid is one kernel
 * call, its outline k being copy k + 2) names the ones that missed in `missed`, or touches nothing when all did.
 */
function exactEngine(misses: (copy: number) => boolean, copyOf: (x: number) => number) {
  const sent: { op: string; req: R }[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as R
    sent.push({ op, req })
    if (op === 'brep.tessellate') return { ...tri(1), faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.extrude' && req['target'] !== undefined) {
      const outlines = req['polygons'] as unknown[]
      const missed = outlines.length > 1 ? outlines.flatMap((_, k) => (misses(k + 2) ? [k] : [])) : misses(copyOf((req['frame'] as { origin: number[] }).origin[0]!)) ? [0] : []
      if (missed.length === outlines.length) return { touches: false }
      return { touches: true, body: 1, bodySmb: `cut-${++n}`, ...(outlines.length > 1 ? { missed } : {}) }
    }
    if (op.startsWith('brep.')) return { body: 1, bodySmb: `${op.slice(5)}-${++n}` }
    return { mesh: tri(1), removedVolumeMm3: 1 }
  }
  return { call, sent }
}

describe('a pattern of steps on exact solids', () => {
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
  const box = step('box-1', { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 40, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
  const slot = step('slot-1', { op: 'shape.extrude', frame: { ...frame, origin: [-15, 0, 5], normal: [0, 0, -1] }, shape: { type: 'rectangle', widthMm: 2, heightMm: 4 }, spec: { distanceMm: 2, operation: 'cut' } } as StepParams)
  const slots = (count: number) => step('row-1', { op: 'pattern', steps: ['slot-1'], spec: { kind: 'linear', count, step: [6, 0, 0] } })
  const exact = (...steps: Step[]): History => ({ version: 1, base: [], steps, exact: true })
  // copy k of the slot is sent at its own place along the row, its frame 6 mm on from the copy before it
  const slotCopy = (x: number) => Math.round((x + 15) / 6) + 1

  it('keeps the landing copies exact and names the ones that miss', async () => {
    const e = exactEngine((k) => [3, 4].includes(k), slotCopy)
    const r = await replayHistory(e.call, { history: exact(box, slot, slots(5)) })
    expect(r.status[2]).toEqual({ state: 'done', note: 'Copies 3 and 4 did not reach the part and were left out.', copies: { total: 5, kept: 3, missed: [3, 4] } })
    expect(r.exactFellBack).toBeUndefined()
    expect(e.sent.some((s) => s.op === 'subtract' || s.op === 'shape.extrude')).toBe(false)
    // the copies go in one kernel call
    expect(e.sent.filter((s) => s.op === 'brep.extrude')).toHaveLength(3)
    expect(r.status.every((s) => s.note !== EXACT_FELL_BACK)).toBe(true)
  })

  it('breaks when no copy lands, in a strict exact design too', async () => {
    const e = exactEngine((k) => k > 1, slotCopy)
    const r = await replayHistory(e.call, { history: exact(box, slot, slots(3)) })
    expect(r.status[2]).toEqual({ state: 'broken', message: NO_COPY_LANDS })
  })

  it('runs as before when every copy lands', async () => {
    const e = exactEngine(() => false, slotCopy)
    const r = await replayHistory(e.call, { history: exact(box, slot, slots(3)) })
    expect(r.status[2]).toEqual({ state: 'done', copies: { total: 3, kept: 3, missed: [] } })
  })
})
