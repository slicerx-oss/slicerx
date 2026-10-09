// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Paint is per triangle of a part's mesh. A tool that rebuilds a part's triangles (repair, simplify, hollow, subtract,
// text) must not leave the old paint on the new triangle numbers: it clears it on the parts it rebuilt, says so, and
// Undo brings it back with the old mesh.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { setGeomProvider, toGeom } from '../src/geom/client'
import { simplifySelected, textOnSelected } from '../src/plate/geom-ops'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { appStore, get, set, type PaintData } from '../src/state/store'

const host = { loadParts: async (name: string, parts: MeshPart[]): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: parts.reduce((n, p) => n + p.indices.length / 3, 0), bboxMm: [10, 10, 10], openEdges: 0, parts: [] }) }
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 100, 0, 1]
const paint: PaintData = { 0: { color: { 0: '2', 3: '2' } }, 1: { color: { 1: '3' } } }

beforeEach(() => {
  // The engine returns a mesh with its triangles in a new order, as a real simplify or emboss does.
  setGeomProvider({
    call: async <R,>(_op: string, request: unknown): Promise<R> => {
      const mesh = (request as { mesh: ReturnType<typeof toGeom> }).mesh
      return { mesh: { ...mesh, indices: Uint32Array.from(mesh.indices).reverse() }, report: { before: 12, after: 12 } } as R
    },
  })
  const a = { ...boxMesh(10, 10, 10), name: 'a', slot: 1 }
  const b = { ...boxMesh(10, 10, 4), name: 'b', slot: 2 }
  set({ plate: [{ id: 'o', name: 'o', handle: { id: 'o' }, parts: [a, b], colors: [], transform: T, paint } as never], selection: 'o', selectedIds: ['o'] })
})
afterEach(() => setGeomProvider(null))

describe('paint after a tool rebuilds the mesh', () => {
  it('clears the paint, says so, and Undo brings it back', async () => {
    const undo = createHistory(appStore)
    try {
      const msg = await simplifySelected(host, 0.5)
      expect(get().plate[0]!.paint).toBeUndefined()
      expect(msg).toContain('paint was cleared')
      undo.undo()
      expect(get().plate[0]!.paint).toEqual(paint)
    } finally {
      undo.dispose()
    }
  })

  it('keeps the paint of parts the tool left alone', async () => {
    // Text goes on the tallest part (the 10 mm box); the 4 mm one keeps its triangles and its paint.
    const msg = await textOnSelected(host, { text: 'A', sizeMm: 5, depthMm: 1, mode: 'emboss' })
    expect(get().plate[0]!.paint).toEqual({ 1: paint[1] })
    expect(msg).toContain('paint was cleared')
  })
})
