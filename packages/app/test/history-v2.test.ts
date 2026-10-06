// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// History file version 2 (docs/cad-history.md, "Face keys"): a step names the face it works on by the face's key,
// which stays the same when an earlier step changes, and finds it by place only when it has no key. A step from a
// version 1 file gets its key on its first replay. A face split in two is found by its larger part, and the step
// says so. A file from a newer SlicerX opens without its history and says why. Runs against the geometry engine
// (live wasm when built, recorded replies otherwise).
import { describe, expect, it } from 'vitest'
import { geom } from '../src/geom/client'
import { faceKeyAt, HISTORY_VERSION, type History, type HistoryMesh, type Step, type StepParams } from '../src/cad/history/model'
import { clearReplayCache, replayHistory } from '../src/cad/history/replay'
import { reserveStepId, withStep } from '../src/cad/history/record'
import { stepSalt } from '../src/cad/history/salt'
import { setGeomProvider } from '../src/geom/client'
import { historyFiles } from '../src/export/history-file'
import { historyNewer, parseHistories } from '../src/export/history-read'
import { boxMesh } from '../src/plate/mesh-ops'
import { useGeomEngine } from './geom-engine'

useGeomEngine('history-v2-replies')

const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const call = (op: string, r: unknown) => geom().call(op, r)
const frame = (z: number) => ({ origin: [100, 100, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 1, 0] as [number, number, number] })
const step = (id: string, params: StepParams): Step => ({ id, part: 0, transform: T, params })
const boss = (x: number) => step('s1', { op: 'shape.extrude', frame: frame(10), shape: { type: 'circle', diameterMm: 10 }, placement: { center: [x, 0], rotationDeg: 0 }, spec: { distanceMm: 5, operation: 'join' } })
const pull = (faceKey?: number) => step('s2', { op: 'face.push', at: [100, 100, 15], normal: [0, 0, 1], distanceMm: 3, ...(faceKey ? { faceKey } : {}) })
const history = (...steps: Step[]): History => ({ version: HISTORY_VERSION, base: [boxMesh(40, 30, 10)], steps })
const topAt = (m: Pick<HistoryMesh, 'positions'>, x: number, y: number) => {
  let z = -Infinity
  for (let i = 0; i + 2 < m.positions.length; i += 3) {
    if (Math.abs(m.positions[i]! + 100 - x) < 6 && Math.abs(m.positions[i + 1]! + 100 - y) < 6) z = Math.max(z, m.positions[i + 2]!)
  }
  return z
}

/** The highest point of the mesh with world x from `x0` to `x1`. */
const topIn = (m: Pick<HistoryMesh, 'positions'>, x0: number, x1: number) => {
  let z = -Infinity
  for (let i = 0; i + 2 < m.positions.length; i += 3) {
    const x = m.positions[i]! + 100
    if (x >= x0 - 1e-6 && x <= x1 + 1e-6) z = Math.max(z, m.positions[i + 2]!)
  }
  return z
}

async function bossTopKey(): Promise<number> {
  clearReplayCache()
  const r = await replayHistory(call, { history: history(boss(0)) })
  const key = faceKeyAt(r.parts[0]!, T, [100, 100, 15], [0, 0, 1])
  expect(key).toBeGreaterThan(0)
  return key!
}

describe('face keys in the history', () => {
  it('find the face a step works on after an earlier step moved it', async () => {
    const key = await bossTopKey()
    clearReplayCache()
    const moved = await replayHistory(call, { history: history(boss(12), pull(key)) })
    expect(moved.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(topAt(moved.parts[0]!, 112, 100)).toBeCloseTo(18, 6)
    // By place alone the old spot is empty now.
    clearReplayCache()
    const byPlace = await replayHistory(call, { history: history(boss(12), pull()) })
    expect(byPlace.status[1]).toMatchObject({ state: 'broken' })
  })

  it('give a step from a version 1 file its key on the first replay', async () => {
    const key = await bossTopKey()
    clearReplayCache()
    const r = await replayHistory(call, { history: history(boss(0), pull()) })
    expect(r.status.map((s) => s.state)).toEqual(['done', 'done'])
    expect(r.found?.['s2']).toEqual({ faceKey: key })
  })

  it('find a face split in two by its larger part, and say so', async () => {
    clearReplayCache()
    const slot = step('s1', { op: 'shape.extrude', frame: frame(10), shape: { type: 'rectangle', widthMm: 4, heightMm: 40 }, placement: { center: [-8, 0], rotationDeg: 0 }, spec: { distanceMm: 3, operation: 'cut' } })
    const cut = await replayHistory(call, { history: history(slot) })
    const top = faceKeyAt(cut.parts[0]!, T, [110, 100, 10], [0, 0, 1])
    expect(top).toBeGreaterThan(0)
    expect(faceKeyAt(cut.parts[0]!, T, [85, 100, 10], [0, 0, 1])).toBe(top)
    // The push names the top by key from a spot on the smaller part.
    const push = step('s2', { op: 'face.push', at: [85, 100, 10], normal: [0, 0, 1], distanceMm: 2, faceKey: top! })
    clearReplayCache()
    const r = await replayHistory(call, { history: history(slot, push) })
    expect(r.status[1]).toMatchObject({ state: 'done', note: expect.stringMatching(/split in two; picked the larger/) })
    // The larger part (from x 94 to 120) went up; the smaller one (80 to 90) stayed.
    expect(topIn(r.parts[0]!, 94, 120)).toBeCloseTo(12, 6)
    expect(topIn(r.parts[0]!, 80, 90)).toBeCloseTo(10, 6)
  })
})

describe('the history file, version 2', () => {
  const files = (h: History) => new Map(historyFiles([{ id: 'o1', history: h }], new Map([['o1', 1]])).map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data]))

  it('keeps face keys, still opens version 1, and says a newer file cannot be read', () => {
    const v2 = files(history(boss(0), pull(12345)))
    expect(JSON.parse(new TextDecoder().decode(v2.get('Metadata/slicerx_history.json')!)).version).toBe(2)
    expect(parseHistories(v2, new Set(['1'])).get('1')!.steps[1]!.params).toMatchObject({ faceKey: 12345 })
    expect(historyNewer(v2)).toBeNull()
    const v1 = new Map(v2)
    const j = JSON.parse(new TextDecoder().decode(v2.get('Metadata/slicerx_history.json')!))
    v1.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify({ ...j, version: 1 })))
    expect(parseHistories(v1, new Set(['1'])).get('1')!.steps).toHaveLength(2)
    const v3 = new Map(v2)
    v3.set('Metadata/slicerx_history.json', new TextEncoder().encode(JSON.stringify({ ...j, version: 3 })))
    expect(parseHistories(v3, new Set(['1'])).size).toBe(0)
    expect(historyNewer(v3)).toMatch(/saved by a newer SlicerX.*open without their history/)
  })
})

describe('a tool running a step', () => {
  it('gives the engine the salt of the step it will record, so a replay makes the same face keys', async () => {
    const seen: unknown[] = []
    setGeomProvider({ call: async <T,>(_op: string, r: unknown) => (seen.push(r), {} as T) })
    try {
      const id = reserveStepId()
      await geom().call('face.push', { triangle: 0 })
      const h = withStep({ parts: [boxMesh(10, 10, 5)], transform: T }, 0, pull().params)
      expect(h.steps[0]!.id).toBe(id)
      expect(seen[0]).toMatchObject({ keySalt: stepSalt(id) })
      // Used once: the next call carries no salt and the next step gets an id of its own.
      await geom().call('face.push', { triangle: 0 })
      expect(seen[1]).not.toHaveProperty('keySalt')
      expect(withStep({ parts: [boxMesh(10, 10, 5)], transform: T }, 0, pull().params).steps[0]!.id).not.toBe(id)
    } finally {
      setGeomProvider(null)
    }
  })
})
