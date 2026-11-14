// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A big exact part's edges come from the mesh worker once: a new plate with the very same arrays keeps what was built,
// and the edges job is not sent again. A new tessellation (new normals and face ids) is built again.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TorusKnotGeometry } from 'three'
import { packNormals } from '@slicerx/contracts'
import { answerMeshBuild, type MeshBuildReply, type MeshBuildRequest } from '../src/mesh-worker'
import type { MeshWorkerLike } from '../src/mesh-pool'

/** Stands in for any WebGL object: every property is another stand-in, every call returns one, and it reads as 0. */
function standIn(): unknown {
  const fn = function () {} as unknown as object
  const kept = new Map<PropertyKey, unknown>()
  const p: object = new Proxy(fn, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => 0
      if (k === 'then') return undefined
      if (!kept.has(k)) kept.set(k, standIn())
      return kept.get(k)
    },
    set(_t, k, v) {
      kept.set(k, v)
      return true
    },
    apply: () => p,
    construct: () => p,
  })
  return p
}

vi.mock('three', async (orig) => {
  const three = await orig<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: function WebGLRenderer() {
      return standIn()
    },
    PMREMGenerator: class {
      fromScene() {
        return { texture: new three.Texture() }
      }
      compileEquirectangularShader() {}
      dispose() {}
    },
    CubeCamera: class extends three.Object3D {
      update() {}
    },
  }
})

const { createViewport } = await import('../src/viewport')

/** A worker in this thread that answers a tick later and keeps the jobs it was sent. */
class CountingWorker implements MeshWorkerLike {
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  static jobs: MeshBuildRequest[] = []
  postMessage(message: MeshBuildRequest): void {
    CountingWorker.jobs.push(message)
    setTimeout(() => this.onmessage?.({ data: answerMeshBuild(message).reply } as MessageEvent<MeshBuildReply>), 0)
  }
  terminate(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const BED = { widthMm: 180, depthMm: 180, heightMm: 180 }

describe('a big exact part on the plate', () => {
  it('sends its edges job once while its arrays stay the same', async () => {
    // frames are never drawn here: a part's refinement goes on after the capped wait for one
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    // past the viewport's 20,000 triangles that go to the workers
    const g = new TorusKnotGeometry(10, 3, 400, 26)
    const positions = g.getAttribute('position').array as Float32Array
    const indices = new Uint32Array(g.getIndex()!.array)
    const nt = indices.length / 3
    expect(nt).toBeGreaterThanOrEqual(20_000)
    const normals = packNormals(new Float32Array(nt * 9).fill(1))
    const faceIds = Uint32Array.from({ length: nt }, (_, t) => Math.floor(t / 50))
    const plate = (n: Int16Array, ids: Uint32Array) => ({ bed: BED, objects: [{ id: 'k', name: 'k', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 90, 90, 0, 1], parts: [{ name: 'k', color: '#808080', positions, indices, normals: n, faceIds: ids }] }] })
    CountingWorker.jobs = []
    const vp = createViewport(document.createElement('canvas'), { quality: 'low', reveal: false, adaptive: false, meshWorker: () => new CountingWorker() })
    const refined = () => new Promise<void>((r) => {
      const off = vp.on('platerefined', () => (off(), r()))
    })
    const edges = () => CountingWorker.jobs.filter((j) => j.kind === 'edges')

    let once = refined()
    vp.setPlate(plate(normals, faceIds))
    await once
    // every triangle exact: no crease job, one edges job with the face ids
    expect(CountingWorker.jobs.map((j) => j.kind)).toEqual(['edges'])
    expect(edges()[0]!.faceIds).toBe(faceIds)

    // a new plate payload with the very same arrays, as the app sends for a change elsewhere
    vp.setPlate(plate(normals, faceIds))
    await new Promise((r) => setTimeout(r, 200))
    expect(edges()).toHaveLength(1)

    // the engine's next tessellation of the same triangles: new normals and face ids, so the part is built again
    const other = faceIds.map((f) => f + 1)
    once = refined()
    vp.setPlate(plate(normals.slice(), other))
    await once
    expect(edges()).toHaveLength(2)
    expect(edges()[1]!.faceIds).toBe(other)
    vp.dispose()
  })
})
