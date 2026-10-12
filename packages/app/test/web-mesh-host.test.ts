// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser build without the slicing engine keeps the meshes the app registers (real hashes, sizes and parts) and
// refuses to slice with a plain message.
import type { MeshPart } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createMeshHost, NO_SLICING } from '../../../apps/web/src/host/meshes'

const box = (name: string, w: number): MeshPart => ({
  name,
  slot: 1,
  positions: new Float32Array([0, 0, 0, w, 0, 0, w, w, 0, 0, w, 0, 0, 0, w, w, 0, w, w, w, w, 0, w, w]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
})

describe('the mesh-only host', () => {
  it('keeps meshes with their size, parts and a content hash', async () => {
    const host = createMeshHost()
    const a = await host.loadParts('cube', [box('cube', 10)])
    expect(a.triangles).toBe(12)
    expect(a.bboxMm).toEqual([10, 10, 10])
    expect(a.openEdges).toBe(0)
    expect(a.parts).toEqual([{ name: 'cube', slot: 1, triangles: 12 }])
    const same = await host.loadParts('cube', [box('cube', 10)])
    const other = await host.loadParts('cube', [box('cube', 20)])
    expect(same.hash).toBe(a.hash)
    expect(other.hash).not.toBe(a.hash)
    expect(same.id).not.toBe(a.id)
    expect((await host.meshParts!(a.id))[0]!.indices.length).toBe(36)
    host.release(a.id)
    await expect(host.meshParts!(a.id)).rejects.toThrow()
  })

  it('reads a binary STL and leaves other files to the geometry engine', async () => {
    const host = createMeshHost()
    const stl = new ArrayBuffer(84 + 50)
    new DataView(stl).setUint32(80, 1, true)
    const corners = [0, 0, 0, 5, 0, 0, 0, 5, 0]
    corners.forEach((v, k) => new DataView(stl).setFloat32(84 + 12 + k * 4, v, true))
    const h = await host.loadModel(stl, 'tri.stl')
    expect(h.triangles).toBe(1)
    expect(h.bboxMm).toEqual([5, 5, 0])
    await expect(host.loadModel(new ArrayBuffer(10), 'part.3mf')).rejects.toThrow(/geometry engine/)
  })

  it('refuses to slice, preview or export G-code', async () => {
    const host = createMeshHost()
    await expect(host.slice({} as never)).rejects.toThrow(NO_SLICING)
    await expect(host.getPreview('x')).rejects.toThrow(NO_SLICING)
    await expect(host.exportGcode('x', {} as never)).rejects.toThrow(NO_SLICING)
  })
})
