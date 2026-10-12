// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The autosave writes its project file in the project worker. Here the worker is the real project-worker.ts, run in
// this thread behind a stand-in Worker that passes messages as a browser does (a structured clone with the transfer
// list): the file is the same bytes the page writes, the page keeps its meshes, and an autosave written this way opens
// back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { unzipEntries } from '../src/export/import3mf'
import { writeProjectCompressed, type ProjectInput } from '../src/export/threemf'
import { compose } from '../src/plate/transform'
import { autosaveNow, findRecovery, memorySnapshots, setSnapshotStore } from '../src/project/autosave'
import { markClean, startDirtyTracking } from '../src/project/unsaved'
import { set, type PlateEntry, type PlateMeta } from '../src/state/store'

const bed = { widthMm: 256, depthMm: 256 }
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 0, bboxMm: [1, 1, 1], openEdges: 0, parts: [] })

function strip(n: number): MeshPart {
  const positions = new Float32Array((n + 2) * 3)
  for (let i = 0; i < n + 2; i++) positions.set([(i >> 1) * 0.5, i & 1 ? 1.25 : 0, (i % 7) * 0.1], 3 * i)
  const indices = new Uint32Array(n * 3)
  for (let t = 0; t < n; t++) indices.set(t & 1 ? [t + 1, t, t + 2] : [t, t + 1, t + 2], 3 * t)
  return { name: 'Strip', slot: 1, positions, indices }
}

function entry(id: string, n: number): PlateEntry {
  return { id, name: 'Strip', handle: handle(id), parts: [strip(n)], colors: ['#bd93f9'], transform: compose({ position: [100, 90, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }), paint: { 0: { color: { 3: '4', 10: '8' } } } }
}

const plates = (objects: PlateEntry[]): PlateMeta[] => [{ id: 'p1', name: 'Plate 1', objects, settings: {} }]

/** What crossed to the worker on each message: the transfer list. */
const handed: Transferable[][] = []

/** The worker's global scope: project-worker.ts sets its handler here and answers through it. */
let current: ThreadWorker | null = null
const scope = {
  // The test's build turns `new URL(path, import.meta.url)` into a URL against `self.location`.
  location: globalThis.location,
  onmessage: null as ((e: MessageEvent) => void) | null,
  postMessage: (data: unknown, opts?: { transfer?: Transferable[] }) => {
    const copy = structuredClone(data, { transfer: opts?.transfer ?? [] })
    const to = current
    queueMicrotask(() => to?.onmessage?.({ data: copy } as MessageEvent))
  },
}
let loaded: Promise<unknown> | null = null

/** A Worker that runs project-worker.ts in this thread; messages cross as structured clones with their transfer lists. */
class ThreadWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  constructor() {
    current = this
    loaded ??= import('../src/export/project-worker')
  }
  postMessage(data: unknown, transfer: Transferable[] = []): void {
    handed.push(transfer)
    const copy = structuredClone(data, { transfer })
    void loaded!.then(() => scope.onmessage?.({ data: copy } as MessageEvent))
  }
  terminate(): void {}
}

beforeEach(() => {
  handed.length = 0
  vi.stubGlobal('self', scope)
  vi.stubGlobal('Worker', ThreadWorker)
})
afterEach(() => vi.unstubAllGlobals())

describe('the project file written in the worker', () => {
  it('is the same bytes the page writes, and the page keeps its meshes', async () => {
    const { writeProjectInWorker } = await import('../src/export/project-worker-client')
    const objects = [entry('a', 6000), entry('b', 50)]
    const input: ProjectInput = { plates: plates(objects), bed, settings: { layer_height: '0.2' }, application: 'SlicerX' }
    const onPage = await writeProjectCompressed(input)
    const inWorker = await writeProjectInWorker(input)
    expect(inWorker.length).toBe(onPage.length)
    expect(Buffer.from(inWorker).equals(Buffer.from(onPage))).toBe(true)
    // The meshes went over handed over, not copied a second time: copies of the page's, so the page's own still work.
    // One message per part and one for its few painted triangles, then the rest of the project.
    expect(handed.map((t) => t.length)).toEqual([2, 0, 2, 0, 0])
    const sent = handed.flat()
    expect(sent.length).toBe(4)
    const own = objects.flatMap((o) => o.parts.flatMap((p) => [p.positions.buffer, p.indices.buffer]))
    for (const b of sent) expect(own).not.toContain(b)
    for (const b of sent) expect((b as ArrayBuffer).byteLength).toBe(0)
    expect(objects[0]!.parts[0]!.positions.length).toBe(6002 * 3)
    expect(objects[0]!.parts[0]!.indices[3]).toBe(2)
  })

  it('lets the page run between the parts it hands over', async () => {
    const { writeProjectInWorker } = await import('../src/export/project-worker-client')
    const objects = [entry('a', 400), entry('b', 400), entry('c', 400)]
    const input: ProjectInput = { plates: plates(objects), bed, settings: {}, application: 'SlicerX' }
    // What the page did meanwhile, by how many messages had gone to the worker by then.
    const ran: number[] = []
    let live = true
    const tick = (): void => {
      ran.push(handed.length)
      if (live) setTimeout(tick, 0)
    }
    setTimeout(tick, 0)
    const bytes = await writeProjectInWorker(input)
    live = false
    expect(Buffer.from(bytes).equals(Buffer.from(await writeProjectCompressed(input)))).toBe(true)
    // The page ran before the first piece went, between every two pieces, and before the rest of the project went.
    expect(handed.length).toBe(7)
    for (let n = 0; n < 7; n++) expect(ran).toContain(n)
  })

  it('sends a big paint job in pieces, and the file is the same bytes the page writes', async () => {
    const { PAINT_CHUNK, writeProjectInWorker } = await import('../src/export/project-worker-client')
    const n = 2 * PAINT_CHUNK + 500
    const a = entry('a', n + 10)
    const support: Record<number, string> = {}
    const color: Record<number, string> = {}
    for (let t = 0; t < n; t++) support[t] = t % 3 ? '4' : '8'
    for (let t = 0; t < 40; t += 3) color[t] = '8'
    const painted: PlateEntry = { ...a, paint: { 0: { color, support } } }
    const input: ProjectInput = { plates: plates([painted, entry('b', 20)]), bed, settings: {}, application: 'SlicerX' }
    const onPage = await writeProjectCompressed(input)
    const inWorker = await writeProjectInWorker(input)
    expect(Buffer.from(inWorker).equals(Buffer.from(onPage))).toBe(true)
    // Part, color, three pieces of support; part, color; the rest.
    expect(handed.length).toBe(1 + 1 + 3 + 1 + 1 + 1)
    // The page's own paint is untouched.
    expect(Object.keys(painted.paint![0]!.support!).length).toBe(n)
  })

  it('is written on the page when the worker stops partway', async () => {
    setSnapshotStore(memorySnapshots())
    set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false })
    startDirtyTracking()
    markClean()
    // The worker fails as the first part reaches it.
    const post = ThreadWorker.prototype.postMessage
    vi.spyOn(ThreadWorker.prototype, 'postMessage').mockImplementationOnce(function (this: ThreadWorker) {
      queueMicrotask(() => this.onerror?.({ message: 'gone' } as ErrorEvent))
    })
    set({ plate: [entry('a', 200), entry('b', 200)] })
    expect(await autosaveNow()).toBe(true)
    vi.mocked(ThreadWorker.prototype.postMessage).mockRestore()
    expect(ThreadWorker.prototype.postMessage).toBe(post)
    const snap = await findRecovery()
    const model = new TextDecoder().decode((await unzipEntries(snap!.data)).get('3D/3dmodel.model'))
    expect(model.match(/<triangle /g)?.length).toBe(400)
  })

  it('writes an autosave that opens back with the same mesh', async () => {
    setSnapshotStore(memorySnapshots())
    set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false })
    startDirtyTracking()
    markClean()
    set({ plate: [entry('a', 3000)] })
    expect(await autosaveNow()).toBe(true)
    // The write went to the worker: the part, its paint, then the rest.
    expect(handed.length).toBe(3)
    const snap = await findRecovery()
    expect(snap?.objects).toBe(1)
    const model = new TextDecoder().decode((await unzipEntries(snap!.data)).get('3D/3dmodel.model'))
    expect(model.match(/<triangle /g)?.length).toBe(3000)
    expect(model).toContain('<triangle v1="4" v2="3" v3="5" paint_color="4"/>')
  })

  it('is written on the page when the project cannot cross to the worker', async () => {
    setSnapshotStore(memorySnapshots())
    set({ plate: [], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'plate-1', plateLoading: false })
    startDirtyTracking()
    markClean()
    vi.stubGlobal('structuredClone', () => {
      throw new DOMException('could not be cloned', 'DataCloneError')
    })
    set({ plate: [entry('a', 100)] })
    expect(await autosaveNow()).toBe(true)
    // No mesh went over; at most a note to drop the write.
    expect(handed.flat()).toEqual([])
    expect((await findRecovery())?.objects).toBe(1)
  })
})
