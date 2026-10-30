// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The browser build without the slicing engine keeps the meshes the app registers (real hashes, sizes and parts) and
// refuses to slice with a plain message.
import type { MeshPart } from '@slicerx/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMeshHost, NO_SLICING } from '../../../apps/web/src/host/meshes'
import { answerMeshStats, meshStats, type MeshStatsRequest } from '../../../apps/web/src/host/mesh-stats'

const box = (name: string, w: number): MeshPart => ({
  name,
  slot: 1,
  positions: new Float32Array([0, 0, 0, w, 0, 0, w, w, 0, 0, w, 0, 0, 0, w, w, 0, w, w, w, w, 0, w, w]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
})

describe('the mesh-only host', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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

  it('measures a mesh in a worker when the page can start one, so a big project does not hold the page', async () => {
    // A stand-in worker that answers as the real one does, a moment later, and keeps what it was sent.
    const sent: MeshStatsRequest[] = []
    class FakeWorker {
      onmessage: ((e: MessageEvent) => void) | null = null
      onerror: ((e: ErrorEvent) => void) | null = null
      postMessage(req: MeshStatsRequest): void {
        sent.push(req)
        setTimeout(() => this.onmessage?.({ data: answerMeshStats(req) } as MessageEvent), 0)
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', FakeWorker)
    const host = createMeshHost()
    const parts = [box('cube', 10), box('lid', 4)]
    const [a, b] = await Promise.all([host.loadParts('cube', parts), host.loadParts('small', [box('small', 2)])])
    expect(sent.map((r) => r.parts.map((p) => p.name))).toEqual([['cube', 'lid'], ['small']])
    // The worker gets copies: the app keeps its own arrays as they were.
    expect(sent[0]!.parts[0]!.positions).not.toBe(parts[0]!.positions)
    expect(parts[0]!.positions.length).toBe(24)
    // The same numbers as measured on the page, and ids in the order the meshes came.
    expect({ hash: a!.hash, bboxMm: a!.bboxMm, openEdges: a!.openEdges }).toEqual(meshStats(parts))
    expect([a!.id, b!.id]).toEqual(['mesh-1', 'mesh-2'])
    expect(a!.triangles).toBe(24)
    expect((await host.meshParts!(a!.id))[1]!.name).toBe('lid')
  })

  it('measures on the page when the worker fails', async () => {
    class BrokenWorker {
      onmessage: ((e: MessageEvent) => void) | null = null
      onerror: ((e: ErrorEvent) => void) | null = null
      postMessage(): void {
        setTimeout(() => this.onerror?.({ message: 'no worker here' } as ErrorEvent), 0)
      }
      terminate(): void {}
    }
    vi.stubGlobal('Worker', BrokenWorker)
    const host = createMeshHost()
    const h = await host.loadParts('cube', [box('cube', 10)])
    expect(h.bboxMm).toEqual([10, 10, 10])
    expect(h.openEdges).toBe(0)
  })

  it('counts open edges of an open mesh, and of one with indices past its vertices', () => {
    const open: MeshPart = { name: 'tri', slot: 1, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) }
    expect(meshStats([open]).openEdges).toBe(3)
    const cube = box('cube', 10)
    // The cube with its last two triangles gone: the hole has four edges.
    expect(meshStats([{ ...cube, indices: cube.indices.slice(0, 30) }]).openEdges).toBe(4)
    expect(meshStats([{ name: 'far', slot: 1, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 7, 1, 0, 7]) }]).openEdges).toBe(0)
  })

  it('refuses to slice, preview or export G-code', async () => {
    const host = createMeshHost()
    await expect(host.slice({} as never)).rejects.toThrow(NO_SLICING)
    await expect(host.getPreview('x')).rejects.toThrow(NO_SLICING)
    await expect(host.exportGcode('x', {} as never)).rejects.toThrow(NO_SLICING)
  })
})
