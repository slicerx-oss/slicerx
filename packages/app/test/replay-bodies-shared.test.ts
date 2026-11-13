// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Two replays at once on one engine that holds bodies, as the native provider does when two objects are edited
// together: a body one replay works with is never freed under it, even when the other replay's steps push it out of
// the replay cache and that replay ends first. The last replay to stop using it frees it.
import { afterEach, expect, it } from 'vitest'
import { clearReplayCache, IDENTITY, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'

const FIRST = 2 ** 31
const tri = { positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] }

afterEach(() => clearReplayCache())

/** A kernel that holds bodies by number; `hold` is a call it keeps waiting until the test lets it go. */
function engine() {
  const held = new Set<number>()
  const freed: number[] = []
  const missing: number[] = []
  let n = 0
  let gate: Promise<void> | null = null
  let opened = () => {}
  const body = () => {
    const b = FIRST + n++
    held.add(b)
    return { body: b, bodyKeys: [7] }
  }
  const call = async (op: string, request: unknown) => {
    const req = request as Record<string, unknown>
    if (op === 'brep.free') {
      freed.push(req['body'] as number)
      return { freed: held.delete(req['body'] as number) }
    }
    if (op === 'brep.extrude') return body()
    if (op === 'brep.subtract') {
      // the slow cut waits here, after its request named its body
      if ((req['solids'] as { diameterMm: number }[])[0]!.diameterMm === 9) await (gate ??= new Promise((r) => (opened = r)))
      if (!held.has(req['body'] as number)) {
        missing.push(req['body'] as number)
        throw new Error('brep: body: no such body (freed, or from an earlier session)')
      }
      return body()
    }
    if (op === 'brep.tessellate') {
      if (!held.has(req['body'] as number)) {
        missing.push(req['body'] as number)
        throw new Error('brep: body: no such body (freed, or from an earlier session)')
      }
      return { ...tri, faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 7 }] }
    }
    throw new Error(`no ${op} in this engine`)
  }
  return { call, held, freed, missing, open: () => opened() }
}

const BED = { origin: [0, 0, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] }
const box = (id: string, w: number): Step => ({ id, part: 0, transform: [...IDENTITY], params: { op: 'shape.extrude', frame: BED, shape: { type: 'rectangle', widthMm: w, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams })
const cut = (id: string, d: number, x = 0): Step => ({ id, part: 0, transform: [...IDENTITY], params: { op: 'subtract', solids: [{ type: 'cylinder', origin: [x, 0, 0], axis: [0, 0, 1], diameterMm: d, heightMm: 5 }], label: 'Hole' } as StepParams })
const exact = (...steps: Step[]): History => ({ version: 1, base: [], steps, exact: true })
const kept = { keepsBodies: true }

it('never frees a body a running replay uses, when another replay pushes it out of the cache and ends first', async () => {
  const e = engine()
  // a plate with a hole, replayed once so the cache holds its bodies
  const plate = [box('plate', 20), cut('hole', 2)]
  await replayHistory(e.call, { history: exact(...plate) }, kept)
  // the same plate with one more hole, which waits in the engine after naming the plate's body
  const slow = replayHistory(e.call, { history: exact(...plate, cut('slow', 9)) }, kept)
  await new Promise((r) => setTimeout(r, 0))
  // meanwhile another object with enough steps to push the plate out of the cache, replayed to the end
  const other = await replayHistory(e.call, { history: exact(box('rail', 50), ...Array.from({ length: 130 }, (_, i) => cut(`rail-${i}`, 1, i / 10))) }, kept)
  expect(other.status.every((s) => s.state === 'done')).toBe(true)
  e.open()
  const r = await slow
  // the slow replay found its body: none was freed under it
  expect(e.missing).toEqual([])
  expect(r.status.map((s) => s.state)).toEqual(['done', 'done', 'done'])
  // and every body the cache let go is freed once, by the time both replays ended
  expect(new Set(e.freed).size).toBe(e.freed.length)
})
