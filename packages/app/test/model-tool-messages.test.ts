// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// What the Model tools tell a person: real numbers in their messages, plain words for the engine's refusals, nothing
// recorded when nothing changed, and a word when a tool has nothing to do.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADDS_NOTHING_MM3, clearReplayCache, replayHistory, type Miss } from '@slicerx/cad-history'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { setGeomProvider, toGeom } from '../src/geom/client'
import { applyExtrude } from '../src/cad/cad-ops'
import { shellReason } from '../src/cad/holes'
import { holeProblem, simplifySelected, subtractFromSelected } from '../src/plate/geom-ops'
import { dropSelectedToBed } from '../src/plate/edit'
import { extrudeProblem, pushLimit } from '../src/cad/push'
import { sizeWords } from '../src/cad/op-preview'
import { boxMesh } from '../src/plate/mesh-ops'
import { get, set, type PlateEntry } from '../src/state/store'

const host = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [10, 10, 10], openEdges: 0, parts: [] }) }
// standing on the bed at (100, 100)
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const calls: string[] = []

function plate(transform: number[] = T): PlateEntry {
  const a = { ...boxMesh(10, 10, 10), name: 'a', slot: 1 }
  const b = { ...boxMesh(10, 10, 4), name: 'b', slot: 2 }
  return { id: 'o', name: 'Block', handle: { id: 'o' } as MeshHandle, parts: [a, b], colors: [], transform }
}

beforeEach(() => {
  calls.length = 0
  set({ plate: [plate()], selection: 'o', selectedIds: ['o'], toast: null })
})
afterEach(() => setGeomProvider(null))

describe('simplify', () => {
  it('says the real triangle counts, summed over the parts', async () => {
    // the engine reports trianglesBefore and trianglesAfter for each part
    setGeomProvider({
      call: async <R,>(op: string, request: unknown): Promise<R> => {
        calls.push(op)
        const mesh = (request as { mesh: ReturnType<typeof toGeom> }).mesh
        const n = mesh.indices.length / 3
        return { mesh, report: { trianglesBefore: n * 100, trianglesAfter: n * 50, collapses: n * 50, maxErrorMm: 0.01 } } as R
      },
    })
    const msg = await simplifySelected(host, 0.5)
    expect(msg).toBe('Simplified from 2,400 to 1,200 triangles.')
    expect(msg).not.toContain('NaN')
    expect(get().toast?.text).toBe(msg)
  })
})

describe('subtract a shape', () => {
  beforeEach(() => {
    setGeomProvider({
      call: async <R,>(op: string, request: unknown): Promise<R> => {
        calls.push(op)
        return { mesh: (request as { mesh: unknown }).mesh, removedVolumeMm3: 1 } as R
      },
    })
  })

  it('refuses a depth of 0 with a message, asks the engine nothing and records nothing', async () => {
    const before = get().plate[0]!
    await expect(subtractFromSelected(host, { shape: 'cylinder', sizeMm: 5, depthMm: 0, offset: [0, 0] })).rejects.toThrow('The depth must be more than 0 mm, or nothing is cut.')
    expect(calls).toEqual([])
    expect(get().plate[0]).toBe(before)
    expect(get().plate[0]!.history).toBeUndefined()
  })

  it('says what is wrong with the sizes in plain words, never the engine keys', () => {
    expect(holeProblem({ shape: 'cylinder', sizeMm: 0, depthMm: 5 })).toBe('The diameter must be more than 0 mm.')
    expect(holeProblem({ shape: 'box', sizeMm: 0, depthMm: 5 })).toBe('The width must be more than 0 mm.')
    // an empty box reads as NaN, which the engine got as null
    expect(holeProblem({ shape: 'cylinder', sizeMm: Number.NaN, depthMm: 5 })).toBe('Type a number for the diameter.')
    expect(holeProblem({ shape: 'cylinder', sizeMm: 5, depthMm: Number.NaN })).toBe('Type a number for the depth.')
    expect(holeProblem({ shape: 'cylinder', sizeMm: 20000, depthMm: 5 })).toBe('The diameter is too large. The most is 10000 mm.')
    expect(holeProblem({ shape: 'cylinder', sizeMm: 5, depthMm: -1 })).toMatch(/^The depth must be more than 0 mm/)
    expect(holeProblem({ shape: 'cylinder', sizeMm: 5, depthMm: 5 })).toBeNull()
    for (const s of [{ sizeMm: 0, depthMm: 5 }, { sizeMm: Number.NaN, depthMm: 5 }, { sizeMm: 5, depthMm: 0 }]) expect(holeProblem({ shape: 'cylinder', ...s })).not.toMatch(/Mm\b|request|f64/)
  })

  it('still cuts with good sizes, as one recorded step', async () => {
    await subtractFromSelected(host, { shape: 'cylinder', sizeMm: 5, depthMm: 3, offset: [0, 0] })
    expect(calls).toEqual(['subtract', 'subtract'])
    expect(get().plate[0]!.history?.steps).toHaveLength(1)
  })
})

describe('a shape on a face that misses the body', () => {
  const frame = { origin: [100, 100, 10] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
  const reply = (volumeChangeMm3: number, miss?: Miss) => {
    setGeomProvider({
      call: async <R,>(op: string): Promise<R> => {
        calls.push(op)
        // the engine's join left the text's letters floating: a bigger mesh, but touches is false
        const big = boxMesh(40, 40, 12)
        return { mesh: { positions: Array.from(big.positions), indices: Array.from(big.indices) }, tool: { positions: [], indices: [] }, frame: 'target', report: { volumeChangeMm3, touches: false, ...(miss ? { miss } : {}), shells: 3, watertight: true } } as R
      },
    })
  }
  const run = (operation: 'join' | 'cut' = 'join') => applyExtrude(host, { frame, shape: { type: 'rectangle', widthMm: 80, heightMm: 6 }, placement: { center: [0, 0] }, spec: { distanceMm: 1, operation }, target: { objectId: 'o', partIndex: 0 }, name: 'Text' })

  it('keeps the body as it was and records no step when the shape would float off it', async () => {
    reply(240)
    const before = get().plate[0]!
    const r = await run()
    expect(calls).toEqual(['shape.extrude'])
    expect(r).toEqual({ message: 'Part of the shape would float off the body, so nothing changed. Make it smaller or move it onto the face.', warn: true, missed: true })
    expect(get().plate[0]).toBe(before)
    expect(get().plate[0]!.parts[0]!.indices.length).toBe(36)
    expect(get().plate[0]!.history).toBeUndefined()
  })

  it('says the shape is already inside the body when a join would add nothing', async () => {
    // a join off the body always adds a piece, so one that adds no volume sits inside it
    reply(0)
    const before = get().plate[0]!
    const r = await run()
    expect(r).toEqual({ message: 'The shape is already inside the body, so nothing changed. Check the distance and the direction.', missed: true, warn: true })
    expect(get().plate[0]).toBe(before)
  })

  it.each([
    [1e-9, 'The shape is already inside the body, so nothing changed. Check the distance and the direction.'],
    [1e-4, 'Part of the shape would float off the body, so nothing changed. Make it smaller or move it onto the face.'],
  ])('tells a join that adds %s mm³ apart at the shared tolerance', async (volume, message) => {
    expect(ADDS_NOTHING_MM3).toBe(1e-6)
    reply(volume)
    expect((await run()).message).toBe(message)
  })

  it('names how far short of the body the shape stops, and says a shape that only meets it changed nothing', async () => {
    reply(240, { reason: 'apart', gapMm: 4 })
    expect((await run()).message).toBe('The shape stops 4.0 mm short of the body, so nothing changed. Check the distance and the direction.')
    reply(0, { reason: 'apart', gapMm: 1.2 })
    expect((await run('cut')).message).toBe('The shape stops 1.2 mm short of the body, so nothing changed. Check the distance and the direction.')
    // only part of it floats off: no gap to name
    reply(240, { reason: 'apart', gapMm: 0 })
    expect((await run()).message).toBe('Part of the shape would float off the body, so nothing changed. Make it smaller or move it onto the face.')
    reply(0, { reason: 'inside' })
    expect((await run()).message).toBe('The shape is already inside the body, so nothing changed. Check the distance and the direction.')
    reply(0, { reason: 'unchanged' })
    expect((await run('cut')).message).toBe('The shape only touches the body, so nothing changed. Check the distance and the direction.')
  })

  it('says a cut that misses the body changed nothing, and records no step', async () => {
    reply(0)
    const before = get().plate[0]!
    const r = await run('cut')
    expect(r).toEqual({ message: 'The shape does not reach the body, so nothing changed. Check the distance and the direction.', warn: true, missed: true })
    expect(get().plate[0]).toBe(before)
    expect(get().plate[0]!.history).toBeUndefined()
  })
})

describe('a replayed join or cut that changes nothing', () => {
  const frame = { origin: [0, 0, 5] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
  const box = boxMesh(10, 10, 5)
  const base = { name: 'body', slot: 1, positions: Array.from(box.positions), indices: Array.from(box.indices) }
  // the engine changes nothing: a join inside the part or a cut that misses it
  let miss: Miss | undefined
  const engine = async (op: string) => {
    calls.push(op)
    return { mesh: { positions: base.positions, indices: base.indices }, report: { touches: false, ...(miss ? { miss } : {}), volumeChangeMm3: 0, shells: 1, watertight: true } }
  }
  const replayed = (operation: 'join' | 'cut') =>
    replayHistory(engine, { history: { version: 1, base: [base], steps: [{ id: 's1', part: 0, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], params: { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 4, heightMm: 4 }, placement: {}, spec: { distanceMm: 2, operation } } }] } })

  it('says a join sits inside the part, and a cut no longer reaches it', async () => {
    miss = undefined
    clearReplayCache()
    expect((await replayed('join')).status[0]).toMatchObject({ state: 'broken', message: 'The shape is already inside the part, so nothing changed.' })
    clearReplayCache()
    expect((await replayed('cut')).status[0]).toMatchObject({ state: 'broken', message: 'The shape no longer reaches the part.' })
  })

  it.each<[Miss, 'join' | 'cut', string]>([
    [{ reason: 'apart', gapMm: 4 }, 'join', 'The shape stops 4.0 mm short of the part.'],
    [{ reason: 'apart', gapMm: 1.24 }, 'cut', 'The shape stops 1.2 mm short of the part.'],
    [{ reason: 'apart', gapMm: 0.01 }, 'join', 'Part of the shape would float off the part, so nothing changed.'],
    [{ reason: 'inside' }, 'join', 'The shape is already inside the part, so nothing changed.'],
    [{ reason: 'unchanged' }, 'cut', 'The shape only touches the part, so nothing changed.'],
  ])('says why the engine found %j for a %s', async (why, operation, message) => {
    miss = why
    clearReplayCache()
    expect((await replayed(operation)).status[0]).toMatchObject({ state: 'broken', message })
  })
})

describe('shell', () => {
  it('says why Make shell is off', () => {
    expect(shellReason(false, '2', 2)).toBe('Select a body, or click the flat faces to leave open.')
    expect(shellReason(true, '0', 0)).toBe('The wall must be more than 0 mm.')
    expect(shellReason(true, '-1', -1)).toBe('The wall must be more than 0 mm.')
    expect(shellReason(true, '', Number.NaN)).toBe('Type a wall thickness.')
    expect(shellReason(true, 'abc', Number.NaN)).toBe('Type a number for the wall, such as 2.')
    expect(shellReason(true, '2', 2)).toBeNull()
  })
})

describe('drop to bed', () => {
  it('says so when the object already rests on the bed, and changes nothing', () => {
    // the box mesh runs from z 0 up, so this transform already stands it on the bed
    const before = get().plate
    expect(dropSelectedToBed()).toBe(false)
    expect(get().plate).toBe(before)
    expect(get().toast?.text).toMatch(/^Block is already on the (bed|ground)\.$/)
    expect(get().toast?.tone).toBe('info')
  })

  it('drops a floating object without the note', () => {
    set({ plate: [plate([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 7, 1])], toast: null })
    expect(dropSelectedToBed()).toBe(true)
    expect(get().plate[0]!.transform[14]).toBeCloseTo(0)
    expect(get().toast).toBeNull()
  })
})

describe('an extrude past the engine limit', () => {
  it('says the distance is too large, never that it must not be zero', () => {
    // a sketch extrude of 1000000 mm: the engine's own reply reads "distanceMm: must not be zero (at most 10000 mm)"
    expect(extrudeProblem({ distanceMm: 1_000_000 })).toBe('The distance is too large. The most is 10000 mm.')
    expect(extrudeProblem({ distanceMm: 5, distance2Mm: 20_000 })).toBe('The second distance is too large. The most is 10000 mm.')
    expect(extrudeProblem({ distanceMm: 0 })).toBe('The distance must be more than 0 mm.')
    expect(extrudeProblem({ distanceMm: 5, distance2Mm: 0 })).toBe('The second distance must be more than 0 mm.')
    expect(extrudeProblem({ distanceMm: 5, taperDeg: 50 })).toBe('The draft is between -45 and 45 degrees.')
    expect(extrudeProblem({ distanceMm: 10_000, distance2Mm: 3, taperDeg: -45 })).toBeNull()
    expect(pushLimit(10_001)).toBe('The distance is too large. The most is 10000 mm.')
  })
  it('puts a refusal that still comes back in plain words', () => {
    // what Sketch and Shape on a face now show for the engine's range check, with the typed distance
    expect(sizeWords('DistanceMm: must not be zero (at most 10000 mm)', 1_000_000)).toBe('The distance is too large. The most is 10000 mm.')
  })
})
