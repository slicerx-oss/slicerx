// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { applyExtrude } from '../src/cad/cad-ops'
import { type MeshResult } from '../src/geom/cad'
import { setGeomProvider } from '../src/geom/client'
import { createHistory } from '../src/plate/history'
import { identity } from '../src/plate/transform'
import { get, set } from '../src/state/store'
import { liveEngine, wasmGeom } from './geom-engine'

let engine: Awaited<ReturnType<typeof wasmGeom>>
beforeAll(async () => {
  if (!liveEngine) return
  engine = await wasmGeom()
  setGeomProvider(engine)
})
afterAll(() => setGeomProvider(null))

it.skipIf(!liveEngine)('an unsafe stored cut leaves the mesh, design history and undo unchanged', async () => {
  const frame = (z: number) => ({ origin: [20, 15, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
  const plate = await engine.call<MeshResult>('shape.extrude', {
    frame: frame(0), shape: { type: 'rectangle', widthMm: 40, heightMm: 30 }, spec: { operation: 'new', distanceMm: 5 },
  })
  const embossed = await engine.call<MeshResult>('shape.extrude', {
    target: { mesh: plate.mesh }, frame: frame(5), shape: { type: 'text', text: 'BRIDGE', sizeMm: 7 }, spec: { operation: 'join', distanceMm: 0.8 },
  })
  const part: MeshPart = { name: 'Embossed plate', slot: 1, positions: new Float32Array(embossed.mesh.positions), indices: new Uint32Array(embossed.mesh.indices) }
  const handle = (name: string): MeshHandle => ({ id: name, hash: name, name, triangles: part.indices.length / 3, bboxMm: [40, 30, 5.8], openEdges: 0, parts: [] })
  const host = { loadParts: vi.fn(async (name: string) => handle(name)) }
  set({ plate: [{ id: 'plate', name: part.name, handle: handle(part.name), parts: [part], transform: identity(), colors: ['#bd93f9'] }], selection: 'plate', selectedIds: ['plate'], historyEdit: null })
  const undo = createHistory()
  try {
    const common = { target: { objectId: 'plate', partIndex: 0 }, placement: { rotationDeg: 17 }, name: 'Rectangle' }
    await applyExtrude(host, { ...common, frame: { origin: [20, 15, 5], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 20, heightMm: 12 }, spec: { operation: 'join', distanceMm: 5 } })
    const before = get()
    const snapshots = [...undo.snapshots()]
    host.loadParts.mockClear()
    await expect(applyExtrude(host, { ...common, frame: { origin: [20, 15, 10], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, shape: { type: 'rectangle', widthMm: 10, heightMm: 12 }, spec: { operation: 'cut', distanceMm: 5 } })).rejects.toThrow(/mesh storage precision \((collapsed triangles|intersecting faces)\)/)
    expect(host.loadParts).not.toHaveBeenCalled()
    expect(get().plate).toBe(before.plate)
    expect(get().plate[0]!.history).toBe(before.plate[0]!.history)
    expect(get().selection).toBe(before.selection)
    expect(undo.snapshots()).toEqual(snapshots)
    expect(undo.undo()).toBe(true)
    expect(get().plate[0]!.parts[0]).toBe(part)
  } finally {
    undo.dispose()
  }
})
