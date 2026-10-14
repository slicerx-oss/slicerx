// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { beforeEach, expect, it } from 'vitest'
import { clearReplayCache, IDENTITY, replayHistory, type History, type HistoryMesh } from '@slicerx/cad-history'
import init from '../../brep/lib/sx_brep.mjs'
import { brepModule } from '../src/geom/brep'

beforeEach(() => clearReplayCache())
const mesh: HistoryMesh = { name: 'Face', slot: 1, positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2], faces: { ids: [0], keys: [7], table: [{ kind: 'plane', normal: [0, 0, 1], offset: 0 }] } }
const history = (base: HistoryMesh[], key: number): History => ({ version: 1, base, steps: [{ id: 'push', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [1, 1, 0], normal: [0, 0, 1], distanceMm: 1, faceKey: key } }] })

it('does not replace a missing key with the face at the saved point', async () => {
  let calls = 0
  const r = await replayHistory(async () => { calls++; return { mesh } }, { history: history([mesh], 9) })
  expect(r.status[0]).toMatchObject({ state: 'broken', message: expect.stringMatching(/Missing face.*repair/) })
  expect(calls).toBe(0)
  expect(r.parts[0]!.positions).toEqual(mesh.positions)
})

it('does not select the larger split region or competing coplanar face', async () => {
  for (const ids of [[0, 0], [0, 1]]) {
    const split = { ...mesh, positions: [...Array.from(mesh.positions), 20, 0, 0, 40, 0, 0, 20, 20, 0], indices: [0, 1, 2, 3, 4, 5], faces: { ids, keys: [7, 7], table: [mesh.faces!.table[0]!, mesh.faces!.table[0]!] } }
    let calls = 0
    const r = await replayHistory(async () => { calls++; return { mesh } }, { history: history([split], 7) })
    expect(r.status[0]).toMatchObject({ state: 'broken', message: expect.stringMatching(/Ambiguous face.*repair/) })
    expect(calls).toBe(0)
  }
})

it.each(['', 'brep: '])('does not fall back after an exact reference failure with prefix %s', async (prefix) => {
  const h = history([], 9)
  h.steps.unshift({ id: 'box', part: 0, transform: [...IDENTITY], params: { op: 'shape.extrude', frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 10, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } })
  const calls: string[] = []
  const r = await replayHistory(async (op) => {
    calls.push(op)
    if (op === 'brep.push') throw new Error(`${prefix}faceReference: missing face; pick the face again to repair this step`)
    if (op === 'brep.tessellate') return { ...mesh, faceIds: [0], faces: [{ id: 0, key: 7, surface: mesh.faces!.table[0] }] }
    return { body: 1, bodySmb: 'saved', mesh }
  }, { history: h, exact: true })
  expect(r.status[1]).toMatchObject({ state: 'broken', message: expect.stringMatching(/repair/) })
  expect(calls).not.toContain('face.push')
  expect(r.exactFellBack).toBeUndefined()
})

it('requires repair for deleted, split and merged kernel faces, including after save and reload', async () => {
  const k = brepModule(await init({ wasmBinary: readFileSync(new URL('../../brep/lib/sx_brep.wasm', import.meta.url)) }))
  const held: number[] = []
  const make = (op: string, req: object) => { const r = k.call(op, req) as { body: number; bodySmb: string }; held.push(r.body); return r }
  const faces = (body: unknown) => (k.call('tessellate', { body }) as { faces: { key: number; surface: { normal: number[]; offset: number } }[] }).faces
  const count = () => (k.call('count', {}) as { bodies: number }).bodies
  const before = count()
  try {
    const box = make('box', { min: [0, 0, 0], max: [20, 20, 20], keySalt: 7 })
    const key = faces(box.body).find((f) => f.surface.normal[2] === 1)!.key
    for (const [name, min, max, op, at] of [
      ['deleted', [-1, -1, 15], [21, 21, 21], 'difference', [2, 2, 15]],
      ['split', [5, -1, 15], [9, 21, 21], 'difference', [2, 2, 20]],
      ['merged', [20, 0, 0], [30, 20, 20], 'union', [2, 2, 20]],
    ] as const) {
      const tool = make('box', { min, max, keySalt: 9 })
      const edited = make('boolean', { a: box.body, b: tool.body, op, save: true })
      for (const body of [edited.body, { smb: edited.bodySmb }]) {
        expect(() => k.call('push', { body, faceKey: key, at, normal: [0, 0, 1], distanceMm: 1 }), name).toThrow(/faceReference:.*repair/)
      }
    }
    // a unique key survives save/reload and still names the intended face
    const saved = k.call('save', { body: box.body }) as { smb: string }
    const pushed = make('push', { body: { smb: saved.smb }, faceKey: key, at: [2, 2, 20], normal: [0, 0, 1], distanceMm: 1 })
    expect((k.call('info', { body: pushed.body }) as { volumeMm3: number }).volumeMm3).toBeCloseTo(8400, 6)
  } finally {
    for (const body of held) k.call('free', { body })
  }
  expect(count()).toBe(before)
})
