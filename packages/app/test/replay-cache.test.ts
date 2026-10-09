// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The replay cache returns a step's result only for exactly the same inputs: every base coordinate and index, and the
// content of a font, not just its name. A warm replay returns what a cold one does, moved faces included.
import { beforeEach, expect, it } from 'vitest'
import { IDENTITY, type History, type HistoryMesh } from '../src/cad/history/model'
import { clearReplayCache, replayHistory } from '../src/cad/history/replay'

const mesh = (): HistoryMesh => ({ name: 'same-name', slot: 1, positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], indices: [0, 1, 2] })
const hist = (base: HistoryMesh): History => ({ version: 1, base: [base], steps: [{ id: 'repair-1', part: 0, transform: [...IDENTITY], params: { op: 'repair' } }] })
const pass = async (_op: string, request: unknown) => ({ mesh: (request as { mesh: unknown }).mesh })

beforeEach(() => clearReplayCache())

it('changed triangle connectivity misses the cache', async () => {
  const a = mesh()
  const b = { ...mesh(), indices: [0, 2, 3] }
  await replayHistory(pass, { history: hist(a) })
  const result = await replayHistory(pass, { history: hist(b) })
  expect(Array.from(result.parts[0]!.indices)).toEqual(b.indices)
})

it('a changed coordinate the old sample skipped misses the cache', async () => {
  const positions = Array.from({ length: 192 }, (_, i) => (i % 3 === 0 ? Math.floor(i / 3) % 8 : i % 3 === 1 ? Math.floor(i / 24) : 0))
  const a = { ...mesh(), positions }
  const b = { ...a, positions: positions.slice() }
  b.positions[1] = 0.5
  await replayHistory(pass, { history: hist(a) })
  const result = await replayHistory(pass, { history: hist(b) })
  expect(result.parts[0]!.positions[1]).toBe(0.5)
})

it('the same base still hits the cache', async () => {
  let calls = 0
  const counting = async (op: string, req: unknown) => (calls++, pass(op, req))
  await replayHistory(counting, { history: hist(mesh()) })
  await replayHistory(counting, { history: hist(mesh()) })
  expect(calls).toBe(1)
})

it('a font replaced under the same name misses the cache', async () => {
  const history: History = { version: 1, base: [], steps: [{ id: 'text-1', part: 0, transform: [...IDENTITY], params: { op: 'shape.extrude', shape: { type: 'text', text: 'A', sizeMm: 10 }, font: 'same.ttf', spec: { distanceMm: 1, operation: 'new' } } as never }] }
  const call = async (_op: string, req: unknown) => ({ mesh: { ...mesh(), positions: [(req as { fontBase64: string }).fontBase64 === 'QQ==' ? 1 : 2, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0] } })
  await replayHistory(call, { history, fonts: { 'same.ttf': 'QQ==' } })
  const result = await replayHistory(call, { history, fonts: { 'same.ttf': 'Qg==' } })
  expect(result.parts[0]!.positions[0]).toBe(2)
})

it('a warm replay returns the moved faces a cold one does', async () => {
  const m = mesh()
  const history: History = { version: 1, base: [m], steps: [{ id: 'push-1', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [5, 3, 0], normal: [0, 0, 1], distanceMm: 1 } }] }
  const moved = { frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, outline: [], distanceMm: 1 }
  const first = await replayHistory(async () => ({ mesh: m, moved }), { history })
  const cached = await replayHistory(async () => {
    throw new Error('Should hit the cache')
  }, { history })
  expect(first.moved['push-1']).toEqual(moved)
  expect(cached.moved).toEqual(first.moved)
  expect(cached.status).toEqual(first.status)
})
