// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The embedded view builds big parts in its own mesh worker: it starts one where the page has workers, takes a host's
// own factory, builds on the page when turned off or when the worker fails, and the worker's geometry is the page's.
import type { MeshWorkerLike, ViewportObject, ViewportPlate } from '@slicerx/viewport'
import { LineBasicMaterial, MeshBasicMaterial, TorusKnotGeometry } from 'three'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// the viewport's own building blocks, to check the geometry the worker path ends with
import { MeshBuildPool } from '../../ui/viewport/src/mesh-pool'
import type { MeshBuildReply, MeshBuildRequest, MeshWorkerScope } from '../../ui/viewport/src/mesh-worker'
import { buildObject, type ObjectEntry } from '../../ui/viewport/src/model'
import { defineSlicerXElements } from '../src/elements'
import { meshWorkerFactory } from '../src/mesh-workers'
import { Viewport, type ViewportProps } from '../src/viewport'

let created: Record<string, unknown>[] = []

vi.mock('@slicerx/viewport', async (actual) => ({
  ...(await actual<typeof import('@slicerx/viewport')>()),
  createViewport: (_: HTMLCanvasElement, opts: Record<string, unknown>) => {
    created.push(opts)
    return new Proxy({}, { get: (_t, key) => (key === 'on' ? () => () => {} : () => undefined) })
  },
}))

/** A Worker as the page would make it: records what it was made from, and fails on its first job when told to. */
class PageWorker implements MeshWorkerLike {
  static made: { url: string; opts: WorkerOptions | undefined }[] = []
  static broken = false
  onmessage: ((e: MessageEvent<MeshBuildReply>) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  terminated = false
  constructor(url: URL | string, opts?: WorkerOptions) {
    PageWorker.made.push({ url: String(url), opts })
  }
  postMessage(): void {
    if (PageWorker.broken) setTimeout(() => this.onerror?.({ message: 'the worker script did not load' } as ErrorEvent), 0)
  }
  terminate(): void {
    this.terminated = true
  }
}

const plate = (): ViewportPlate => ({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 }, objects: [] })
let host: HTMLDivElement
let root: Root
const draw = (p: ViewportProps) => act(() => root.render(<Viewport {...p} />))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  created = []
  PageWorker.made = []
  PageWorker.broken = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('the embedded view and its mesh worker', () => {
  it('gives the view a module worker of its own where the page has workers', async () => {
    vi.stubGlobal('Worker', PageWorker)
    await draw({ plate: plate() })
    const make = created[0]?.['meshWorker'] as (() => MeshWorkerLike) | undefined
    expect(typeof make).toBe('function')
    const w = make!()
    expect(w).toBeInstanceOf(PageWorker)
    expect(PageWorker.made[0]?.url).toMatch(/mesh-build-worker/)
    expect(PageWorker.made[0]?.opts?.type).toBe('module')
  })

  it("takes the host's own worker factory", async () => {
    vi.stubGlobal('Worker', PageWorker)
    const own = () => new PageWorker('/static/host-mesh-worker.js', { type: 'module' })
    await draw({ plate: plate(), meshWorker: own })
    expect(created[0]?.['meshWorker']).toBe(own)
  })

  it('builds on the page when the host turns the worker off', async () => {
    vi.stubGlobal('Worker', PageWorker)
    await draw({ plate: plate(), meshWorker: false })
    expect(created[0]).not.toHaveProperty('meshWorker')
    expect(PageWorker.made).toHaveLength(0)
  })

  it('builds on the page where the page has no workers', async () => {
    vi.stubGlobal('Worker', undefined)
    await draw({ plate: plate() })
    expect(created[0]).not.toHaveProperty('meshWorker')
  })

  it('reads mesh-worker="off" on <sx-viewport>', async () => {
    vi.stubGlobal('Worker', PageWorker)
    defineSlicerXElements()
    const on = document.createElement('sx-viewport')
    const off = document.createElement('sx-viewport')
    off.setAttribute('mesh-worker', 'off')
    await act(async () => {
      document.body.append(on, off)
    })
    expect(created).toHaveLength(2)
    expect(typeof created[0]?.['meshWorker']).toBe('function')
    expect(created[1]).not.toHaveProperty('meshWorker')
    await act(async () => {
      on.remove()
      off.remove()
    })
  })
})

function knot(): ViewportObject {
  const g = new TorusKnotGeometry(10, 3, 64, 12)
  const positions = g.getAttribute('position').array as Float32Array
  const indices = new Uint32Array(g.getIndex()!.array)
  return { id: 'o1', name: 'knot', transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], parts: [{ name: 'p', positions, indices, color: '#cccccc' }] }
}

/** Builds an object with the pool, the part counted big, and resolves once its final geometry is in. */
function buildWith(pool: MeshBuildPool, o: ViewportObject): Promise<ObjectEntry> {
  return new Promise((resolve) => {
    const entry = buildObject(o, () => new MeshBasicMaterial(), new LineBasicMaterial(), { pool, minTriangles: 100, done: () => resolve(entry) })
  })
}

function geometryOf(entry: ObjectEntry) {
  const p = entry.parts[0]!
  return {
    position: Array.from(p.mesh.geometry.getAttribute('position').array),
    normal: Array.from(p.mesh.geometry.getAttribute('normal').array),
    index: Array.from(p.mesh.geometry.getIndex()!.array),
    edges: Array.from(p.edges.geometry.getAttribute('position').array),
  }
}

describe("the embed's worker module", () => {
  /** Loads src/mesh-build-worker.ts with a worker global of its own, and returns a Worker-like handle to it. */
  async function loadWorker(): Promise<MeshWorkerLike> {
    const scope: MeshWorkerScope = { onmessage: null, postMessage: () => undefined }
    vi.stubGlobal('self', scope)
    vi.resetModules()
    await import('../src/mesh-build-worker')
    const handle: MeshWorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage: (m: MeshBuildRequest) => setTimeout(() => scope.onmessage?.({ data: m } as MessageEvent<MeshBuildRequest>), 0),
      terminate: () => undefined,
    }
    scope.postMessage = (reply: MeshBuildReply) => handle.onmessage?.({ data: reply } as MessageEvent<MeshBuildReply>)
    return handle
  }

  it('makes the same geometry and edges as the page', async () => {
    const worker = await loadWorker()
    const viaWorker = await buildWith(new MeshBuildPool(() => worker, 1), knot())
    const onPage = buildObject(knot(), () => new MeshBasicMaterial(), new LineBasicMaterial())
    expect(geometryOf(viaWorker)).toEqual(geometryOf(onPage))
  })

  it('is replaced by the page when it fails to load or start', async () => {
    const onPage = geometryOf(buildObject(knot(), () => new MeshBasicMaterial(), new LineBasicMaterial()))
    // a worker whose script does not load (a host bundler that dropped it)
    vi.stubGlobal('Worker', PageWorker)
    PageWorker.broken = true
    const failing = await buildWith(new MeshBuildPool(meshWorkerFactory(true)!, 1), knot())
    expect(geometryOf(failing)).toEqual(onPage)
    // a page whose CSP refuses workers: new Worker throws
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new DOMException('refused by the content security policy', 'SecurityError')
        }
      },
    )
    const refused = await buildWith(new MeshBuildPool(meshWorkerFactory(true)!, 1), knot())
    expect(geometryOf(refused)).toEqual(onPage)
  })
})
