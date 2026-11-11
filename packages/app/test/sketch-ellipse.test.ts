// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An ellipse an agent puts in a sketch (design.sketch) as the sketch tab reads, draws, drags and saves it, solved with
// its center placed, and an ellipse step replayed on exact solids as the kernel's true curve.
import { describe, expect, it } from 'vitest'
import { IDENTITY, clearReplayCache, replayHistory, type History, type SketchLoop, type Step, type StepParams } from '@slicerx/cad-history'
import { settle } from '../src/cad/sketch-dimension'
import { deleteSegment, entityPaths, fromLoops, handles, moveHandle, pickedText, toLoops, type Entity } from '../src/cad/sketch-model'
import { useGeomEngine } from './geom-engine'

useGeomEngine('sketch-ellipse-replies')

const loops: SketchLoop[] = [
  { points: [[-20, -10], [20, -10], [20, 10], [-20, 10]] },
  { type: 'ellipse', center: [4, 2], widthMm: 12, heightMm: 6, angleDeg: 30 },
]

describe('an ellipse in the sketch tab', () => {
  it('reads, draws and saves back as it was given', () => {
    const drawn = fromLoops(loops)!
    expect(drawn[1]).toEqual({ kind: 'ellipse', center: [4, 2], widthMm: 12, heightMm: 6, angleDeg: 30 })
    expect(toLoops(drawn)[1]).toEqual(loops[1])
    // no turn is left out, as a circle leaves nothing extra
    expect(toLoops([{ kind: 'ellipse', center: [0, 0], widthMm: 4, heightMm: 2, angleDeg: 0, construction: true }])).toEqual([{ type: 'ellipse', center: [0, 0], widthMm: 4, heightMm: 2, construction: true }])
    const [ring] = entityPaths(drawn[1]!)
    expect(ring!.closed).toBe(true)
    for (const [x, y] of ring!.points) {
      const t = (-30 * Math.PI) / 180
      const [u, v] = [(x - 4) * Math.cos(t) - (y - 2) * Math.sin(t), (x - 4) * Math.sin(t) + (y - 2) * Math.cos(t)]
      expect((u / 6) ** 2 + (v / 3) ** 2).toBeCloseTo(1, 9)
    }
    expect(pickedText(drawn, { e: 1, seg: 0 })).toBe('Ellipse, 12.00 by 6.00 mm')
    // a whole ellipse goes when its curve is deleted
    expect(deleteSegment(drawn, 1, 0)).toHaveLength(1)
  })

  it('drags by its center and the ends of its axes', () => {
    const drawn = fromLoops(loops)!
    const h = handles(drawn)
    const mine = h.refs.flatMap((r, i) => (r.e === 1 ? [{ r, at: h.points[i]! }] : []))
    expect(mine.map((m) => m.r.at)).toEqual(['center', 'rim', 'rim2'])
    expect(mine[1]!.at[0]).toBeCloseTo(4 + 6 * Math.cos(Math.PI / 6), 9)
    expect(mine[2]!.at[1]).toBeCloseTo(2 + 3 * Math.cos(Math.PI / 6), 9)
    const moved = (ref: (typeof mine)[number]['r'], p: [number, number]) => moveHandle(drawn, ref, p)[1] as Extract<Entity, { kind: 'ellipse' }>
    expect(moved(mine[0]!.r, [0, 0]).center).toEqual([0, 0])
    // the width axis's end sets the width and the turn, the height axis's end the height
    expect(moved(mine[1]!.r, [4, 9])).toMatchObject({ widthMm: 14, angleDeg: 90, heightMm: 6 })
    expect(moved(mine[2]!.r, [4, 4])).toMatchObject({ widthMm: 12, heightMm: 4, angleDeg: 30 })
  })

  it('solves with its center placed from the origin', async () => {
    const r = await settle(fromLoops(loops)!, [
      { type: 'horizontalDistance', a: { e: -1, at: 'start' }, b: { e: 1, at: 'center' }, value: 5 },
      { type: 'verticalDistance', a: { e: -1, at: 'start' }, b: { e: 1, at: 'center' }, value: 3 },
    ])
    expect(r.solved.status, JSON.stringify(r.solved)).not.toBe('conflict')
    expect(r.solved.status, JSON.stringify(r.solved)).toBe('ok')
    const e = r.sketch[1] as Extract<Entity, { kind: 'ellipse' }>
    expect(e.center[0]).toBeCloseTo(5, 6)
    expect(e.center[1]).toBeCloseTo(3, 6)
    expect([e.widthMm, e.heightMm, e.angleDeg]).toEqual([12, 6, 30])
  })
})

describe('an ellipse step on exact solids', () => {
  const frame = { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
  const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: [...IDENTITY], params })
  const history = (...steps: Step[]): History => ({ version: 1, base: [], steps })
  function engine(profiles: unknown[] = []) {
    const sent: { op: string; req: Record<string, unknown> }[] = []
    const call = async (op: string, request: unknown) => {
      const req = request as Record<string, unknown>
      sent.push({ op, req })
      if (op === 'sketch.curves') return profiles
      if (op === 'brep.tessellate') return { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2], faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 7 }] }
      return { body: 1, bodySmb: `${op}-${sent.length}` }
    }
    return { call, sent }
  }

  it('sends Add shape and sketch ellipses to the kernel as curves, turned and moved with the step', async () => {
    clearReplayCache()
    const e = engine()
    const shaped = step('ellipse-1', { op: 'shape.extrude', frame, shape: { type: 'ellipse', widthMm: 20, heightMm: 10 }, placement: { center: [1, 2], rotationDeg: 30 }, spec: { distanceMm: 5, operation: 'new' } })
    await replayHistory(e.call, { history: history(shaped), exact: true })
    expect(e.sent[0]).toMatchObject({ op: 'brep.extrude', req: { polygons: [{ outer: { center: [1, 2], widthMm: 20, heightMm: 10, angleDeg: 30 }, holes: [] }] } })

    clearReplayCache()
    const f = engine([{ outer: { points: [[-9, -9], [9, -9], [9, 9], [-9, 9]] }, holes: [{ center: [0, 0], widthMm: 6, heightMm: 4, angleDeg: 10 }] }])
    const sketched = step('sketch-1', { op: 'shape.extrude', frame, shape: { type: 'sketch', loops }, placement: { center: [1, 2] }, spec: { distanceMm: 5, operation: 'new' } })
    await replayHistory(f.call, { history: history(sketched), exact: true })
    const brep = f.sent.find((s) => s.op === 'brep.extrude')!
    expect((brep.req['polygons'] as { holes: unknown[] }[])[0]!.holes).toEqual([{ center: [1, 2], widthMm: 6, heightMm: 4, angleDeg: 10 }])
  })
})
