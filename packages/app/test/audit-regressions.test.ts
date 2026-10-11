// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The external audit's app findings (2026-10-09), each as its minimized repro, so the fixes that closed them stay
// closed:
// - INT-001: a stale slice is not exported or sent (#415)
// - INT-002: a slice that lands after cancel or clear publishes nothing (#377)
// - INT-003: a new project drops the old resume plan (#155)
// - INT-004: a resume change marks the slice stale and slices again (#155)
// - CAD-001 and CAD-002: the replay cache keys on the whole mesh and on font content (#192)
// - CAD-003: a late modeling result keeps what changed meanwhile (#182; the cut cases are in late-commit.test.ts)
// - CAD-004: a cached replay keeps its moved-face facts
// - CAD-005: repair, simplify and hollow drop paint on the triangles they rebuild (#217; text in geom-ops-paint.test.ts)
// - CAD-007: the 3MF reader takes vertex attributes in any order
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, MeshHandle, MeshPart, SliceResult } from '@slicerx/contracts'
import { IDENTITY, clearReplayCache, replayHistory, type History, type HistoryMesh } from '@slicerx/cad-history'
import { applyHistory } from '../src/cad/history/ops'
import { readProject } from '../src/export/import3mf'
import { zip } from '../src/export/zip'
import { setGeomProvider } from '../src/geom/client'
import { hollowSelected, repairSelected, simplifySelected } from '../src/plate/geom-ops'
import { clearProject } from '../src/project/new'
import { cancelSlice, exportGcode, sendToPrinter, slicePlate } from '../src/state/actions'
import { startAutoSlice } from '../src/state/auto-slice'
import { get, set, type PlateEntry } from '../src/state/store'

const initial = get()
const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const boxHandle = { id: 'mesh-a', hash: 'a', name: 'analytic-box', triangles: 12, bboxMm: [20, 20, 20], openEdges: 0, parts: [{ name: 'box', slot: 1, triangles: 12 }] }
const box = { id: 'a', name: 'analytic-box', handle: boxHandle, parts: [], colors: [], transform: T } as never
const result = { id: 'old-result', engine: 'sx', layerCount: 1, layerZ: new Float32Array([0.2]), layerTimeS: new Float32Array([1]), stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1, warnings: [] } as SliceResult

/** A one-layer SXPV preview. */
function preview(): ArrayBuffer {
  const b = new ArrayBuffer(48)
  const d = new DataView(b)
  d.setUint32(0, 0x56505853, true)
  d.setUint16(4, 1, true)
  d.setUint32(12, 1, true)
  d.setUint32(20, 1, true)
  d.setFloat32(24, 0.2, true)
  d.setFloat32(40, 0.2, true)
  return b
}

describe('slices that no longer match the plate', () => {
  beforeEach(() => set({ ...initial, plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', slice: { status: 'idle' }, autoSlice: false, overrides: { smart_layer: 'off' }, resume: null, calibration: {}, layerMarks: {}, historyEdit: null, printSheet: null }))
  afterEach(() => {
    cancelSlice({ quiet: true })
    set(initial)
    vi.restoreAllMocks()
  })

  it('INT-001: a stale slice is not exported', async () => {
    const save = vi.fn()
    const exportOut = vi.fn(async () => ({ blob: new Blob(['G1 X20 E1']), bytes: 9, sha256: '' }))
    set({ slice: { status: 'done', result, stale: true } })
    await exportGcode({ files: { save }, slicer: { exportGcode: exportOut } } as unknown as Host)
    expect(save).not.toHaveBeenCalled()
  })

  it('INT-001: a stale slice is not sent to a printer', async () => {
    const upload = vi.fn()
    const exportOut = vi.fn(async () => ({ blob: new Blob(['G1 X20 E1']), bytes: 9, sha256: '' }))
    const printers = { status: async () => ({ state: 'idle', slots: [] }), upload, start: vi.fn() }
    const approvals = { register: async () => undefined, grant: async (id: string) => ({ requestId: id }), deny: async () => undefined }
    const host = { kind: 'web', printers, approvals, slicer: { exportGcode: exportOut } } as unknown as Host
    set({ slice: { status: 'done', result, stale: true } })
    await sendToPrinter(host, { id: 'a1', name: 'A1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu-lan', nozzleCount: 1 } as never)
    expect(exportOut).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(get().printSheet).toBeNull()
  })

  it('INT-002: a preview that lands after cancel and clear publishes nothing', async () => {
    let resolvePreview!: (v: ArrayBuffer) => void
    const raw = new Promise<ArrayBuffer>((r) => (resolvePreview = r))
    const getPreview = vi.fn(() => raw)
    const task = slicePlate({ kind: 'web', capabilities: { threads: 1 }, slicer: { slice: async () => result, getPreview } } as unknown as Host)
    await vi.waitFor(() => expect(getPreview).toHaveBeenCalled())
    cancelSlice({ quiet: true })
    set({ plate: [], slice: { status: 'idle' } })
    resolvePreview(preview())
    await task
    expect(get().slice.status).toBe('idle')
  })

  it('INT-003: a new project drops the previous resume plan', () => {
    set({ resume: { plan: { resumeLayer: 10, printedHeightMm: 2 }, layerTopsMm: [0.2, 0.4] } })
    clearProject()
    expect(get().resume).toBeNull()
  })

  it('INT-004: a resume change marks the finished slice stale and slices again', async () => {
    const slice = vi.fn(async () => result)
    const host = { kind: 'web', capabilities: { threads: 1 }, slicer: { slice, getPreview: async () => preview() } } as unknown as Host
    set({ autoSlice: true, autoSliceBySize: false, slice: { status: 'done', result, stale: false } })
    const stop = startAutoSlice(host, 0)
    try {
      set({ resume: { plan: { resumeLayer: 10, printedHeightMm: 2 } } })
      const s = get().slice
      expect(s.status === 'done' && s.stale).toBe(true)
      await vi.waitFor(() => expect(slice).toHaveBeenCalledTimes(1))
    } finally {
      stop()
    }
  })
})

describe('modeling results', () => {
  const mesh = (): HistoryMesh => ({ name: 'same-name', slot: 1, positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], indices: [0, 1, 2] })
  const hist = (base: HistoryMesh): History => ({ version: 1, base: [base], steps: [{ id: 'repair-1', part: 0, transform: [...IDENTITY], params: { op: 'repair' } }] })
  const pass = async (_op: string, request: unknown) => ({ mesh: (request as { mesh: unknown }).mesh })
  const handle: MeshHandle = { id: 'audit', name: 'audit', hash: 'audit', triangles: 1, bboxMm: [10, 10, 1], openEdges: 0, parts: [] }
  const part = (): MeshPart => ({ name: 'same-name', slot: 1, positions: new Float32Array(mesh().positions), indices: new Uint32Array(mesh().indices) })
  beforeEach(() => clearReplayCache())
  afterEach(() => {
    setGeomProvider(null)
    set({ plate: [], historyEdit: null })
  })

  it('CAD-001: changed triangle connectivity misses the replay cache', async () => {
    const b = { ...mesh(), indices: [0, 2, 3] }
    await replayHistory(pass, { history: hist(mesh()) })
    const out = await replayHistory(pass, { history: hist(b) })
    expect(Array.from(out.parts[0]!.indices)).toEqual(b.indices)
  })

  it('CAD-001: a changed coordinate the old key never sampled misses the replay cache', async () => {
    const positions = Array.from({ length: 192 }, (_, i) => (i % 3 === 0 ? Math.floor(i / 3) % 8 : i % 3 === 1 ? Math.floor(i / 24) : 0))
    const a = { ...mesh(), positions }
    const b = { ...a, positions: positions.slice() }
    b.positions[1] = 0.5
    await replayHistory(pass, { history: hist(a) })
    const out = await replayHistory(pass, { history: hist(b) })
    expect(out.parts[0]!.positions[1]).toBe(0.5)
  })

  it('CAD-002: new font bytes under the same name miss the text replay cache', async () => {
    const history: History = { version: 1, base: [], steps: [{ id: 'text-1', part: 0, transform: [...IDENTITY], params: { op: 'shape.extrude', shape: { type: 'text', text: 'A', sizeMm: 10 }, font: 'same.ttf', spec: { distanceMm: 1, operation: 'new' } } }] }
    const call = async (_op: string, req: unknown) => ({ mesh: { ...mesh(), positions: [(req as { fontBase64: string }).fontBase64 === 'QQ==' ? 1 : 2, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0] } })
    await replayHistory(call, { history, fonts: { 'same.ttf': 'QQ==' } })
    const out = await replayHistory(call, { history, fonts: { 'same.ttf': 'Qg==' } })
    expect(out.parts[0]!.positions[0]).toBe(2)
  })

  it('CAD-003: a replay that lands late keeps a newer move and color', async () => {
    setGeomProvider({ call: async <R>(op: string, req: unknown) => (await pass(op, req)) as R })
    const original: PlateEntry = { id: 'audit-body', name: 'audit', parts: [part()], handle, colors: ['#ffffff'], transform: [...IDENTITY] }
    set({ plate: [original], historyEdit: null })
    let ready!: () => void
    let finish!: (h: MeshHandle) => void
    const atLoad = new Promise<void>((r) => (ready = r))
    const loaded = new Promise<MeshHandle>((r) => (finish = r))
    const loadParts = async (): Promise<MeshHandle> => {
      ready()
      return loaded
    }
    const task = applyHistory({ loadParts }, original.id, { version: 1, base: [mesh()], steps: [] })
    await atLoad
    const moved = [...IDENTITY]
    moved[12] = 50
    set({ plate: [{ ...original, transform: moved, colors: ['#123456'] }] })
    finish(handle)
    await task
    expect(get().plate[0]!.transform[12]).toBe(50)
    expect(get().plate[0]!.colors).toEqual(['#123456'])
  })

  it('CAD-004: a cached replay keeps the moved-face facts', async () => {
    const m = mesh()
    const history: History = { version: 1, base: [m], steps: [{ id: 'push-1', part: 0, transform: [...IDENTITY], params: { op: 'face.push', at: [5, 3, 0], normal: [0, 0, 1], distanceMm: 1 } }] }
    const moved = { frame: { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, outline: [], distanceMm: 1 }
    const first = await replayHistory(async () => ({ mesh: m, moved }), { history })
    const fail = async (): Promise<never> => {
      throw new Error('should hit the cache')
    }
    const cached = await replayHistory(fail, { history })
    expect(first.moved['push-1']).toEqual(moved)
    expect(cached.moved).toEqual(first.moved)
  })

  const tools: [string, () => Promise<string>][] = [
    ['repair', () => repairSelected({ loadParts: async () => handle })],
    ['simplify', () => simplifySelected({ loadParts: async () => handle }, 0.5)],
    ['hollow', () => hollowSelected({ loadParts: async () => handle }, 2)],
  ]
  for (const [name, run] of tools) {
    it(`CAD-005: ${name} drops the paint on the triangles it rebuilt`, async () => {
      const original: PlateEntry = { id: 'paint-body', name: 'paint-body', parts: [part()], handle, colors: ['#ffffff'], transform: [...IDENTITY], paint: { 0: { color: { 0: '2' }, support: { 0: '1' }, seam: { 0: '1' } } } }
      set({ plate: [original], selection: original.id, selectedIds: [original.id] })
      const report = { before: 2, after: 1, materialSavedPercent: 40 }
      setGeomProvider({ call: async <R>() => ({ mesh: { ...mesh(), indices: [0, 2, 3] }, report }) as R })
      await run()
      expect(get().plate[0]!.parts[0]!.indices).toEqual(new Uint32Array([0, 2, 3]))
      expect(get().plate[0]!.paint).toBeUndefined()
    })
  }
})

describe('3MF projects', () => {
  it('CAD-007: vertex attributes in any order', async () => {
    const vertices = '<vertex x="0" y="0" z="0"/><vertex y="0" x="1" z="0"/><vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>'
    const triangles = '<triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/><triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>'
    const file = zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>' },
      { name: '3D/3dmodel.model', data: `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices}</vertices><triangles>${triangles}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>` },
    ])
    const out = await readProject(file, { widthMm: 256, depthMm: 256 })
    expect(out.plates[0]!.objects[0]!.parts[0]!.positions.length).toBe(12)
  })
})
