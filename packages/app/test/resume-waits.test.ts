// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The waits on the way to a print: a slice waits for the profile and the project G-code question before it reads the
// plate, an upload takes as long as the file, and a local start waits on the file's preparation. Whatever changes in
// those waits (another plate shown, a resume plan kept), the slice is only ever recorded for the plate it was asked
// for, and nothing starts that is not the shown plate's slice for its plan as it is then.
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest, type SliceResult } from '@slicerx/contracts'
import { boxMesh } from '../src/plate/mesh-ops'
import { resumeFor, SLICE_NOT_CURRENT } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { EXPORT_SWITCHED, exportAllPlates, exportGcode3mf } from '../src/export/actions'
import { switchPlate } from '../src/plate/plates'
import { sendToPrinter, slicePlate, STALE_SLICE } from '../src/state/actions'
import { notStarted } from '../src/state/send-actions'
import { get, set, type PlateEntry } from '../src/state/store'
import { mimirCommands, SWITCHED_REPLY } from '../src/workspaces/mimir/session'

/** Gates the test holds the profile load and the project G-code question on. */
const gates = vi.hoisted(() => ({ profile: null as Promise<void> | null, question: null as Promise<void> | null, asked: 0 }))
vi.mock('../src/state/profile-sync', async (original) => ({ ...(await original<object>()), profileReady: () => gates.profile ?? Promise.resolve() }))
vi.mock('../src/state/project-gcode', async (original) => ({
  ...(await original<object>()),
  askProjectGcode: async () => {
    gates.asked++
    if (gates.question) await gates.question
    return 'profile'
  },
}))

const part = { ...boxMesh(10, 10, 1), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 1], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
const other: PlateEntry = { ...box, id: 'b', name: 'Other' }
const DEMO = { id: 'demo-1', name: 'Demo 1', vendor: 'Test', model: 'T1', plugin: 'demo', nozzleCount: 1 } as never
/** A printer whose plugin prepares each upload first (a wait between the sheet and the start). */
const PREPARED = { id: 'demo-1', name: 'Demo 1', vendor: 'Test', model: 'T1', plugin: 'bambuddy', nozzleCount: 1 } as never

function rawPreview(): ArrayBuffer {
  const raw = new ArrayBuffer(SXPV_HEADER_BYTES + 2 * 4 + 8 + SXPV_SEGMENT_BYTES)
  const dv = new DataView(raw)
  dv.setUint32(0, SXPV_MAGIC, true)
  dv.setUint16(4, SXPV_VERSION, true)
  dv.setUint32(8, 1, true)
  dv.setUint32(12, 1, true)
  dv.setUint32(20, 4, true)
  dv.setFloat32(24, 0.2, true)
  let o = SXPV_HEADER_BYTES
  dv.setUint32(o, 0, true)
  dv.setUint32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o, 0.2, true)
  dv.setFloat32(o + 4, 1, true)
  o += 8
  dv.setFloat32(o + 8, 10, true)
  dv.setFloat32(o + 16, 0.2, true)
  dv.setUint16(o + 20, 400, true)
  dv.setUint16(o + 22, 200, true)
  return raw
}

/** A gate: `wait` holds until `open` is called; `reached` counts the callers that got to it. */
function gate() {
  let open = () => undefined as void
  const g = { reached: 0, wait: null as Promise<void> | null, open: () => open() }
  g.wait = new Promise<void>((r) => (open = r))
  return g
}

/** A host that slices at once, uploads and prepares on gates when given, and starts locally when `hub`. */
function engine(opts: { hub?: boolean; upload?: ReturnType<typeof gate>; prepare?: ReturnType<typeof gate> } = {}) {
  const requests: SliceRequest[] = []
  const started: unknown[] = []
  const uploads: string[] = []
  const local: unknown[] = []
  const saved: string[] = []
  const host = {
    kind: 'desktop',
    capabilities: { threads: 1 },
    slicer: {
      loadModel: async () => box.handle,
      release: () => undefined,
      getPreview: async () => rawPreview(),
      exportGcode: async () => ({ fileName: 'plate.gcode', bytes: 4, sha256: '', blob: new Blob(['G1\n']) }),
      slice: async (req: SliceRequest) => {
        requests.push(req)
        return { id: `r${requests.length}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings: [], stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 } as unknown as SliceResult
      },
    },
    files: { save: async (name: string) => (saved.push(name), { name }) },
    printers: {
      status: async () => ({ state: 'idle' }),
      list: async () => [],
      start: async (...a: unknown[]) => void started.push(a),
      upload: async (_id: string, file: { name: string }) => {
        if (opts.upload) {
          opts.upload.reached++
          await opts.upload.wait
        }
        uploads.push(file.name)
        return { printerId: 'demo-1', path: `/${file.name}`, name: file.name }
      },
      ...(opts.prepare
        ? {
            prepareUpload: async (_id: string, file: unknown) => {
              opts.prepare!.reached++
              await opts.prepare!.wait
              return file
            },
          }
        : {}),
      ...(opts.hub ? { bed: { state: async () => ({ state: 'unknown' }) }, printLocal: async (...a: unknown[]) => void local.push(a) } : {}),
    },
    approvals: { register: async () => undefined, grant: async (id: string) => ({ id, token: 't' }) },
  } as unknown as Host
  return { host, requests, started, uploads, local, saved }
}

const plan = () => set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: [0.2, 0.3, 0.4, 0.5, 0.6] }) })
const toPlate2 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-1' ? { ...p, objects: get().plate } : p)), plate: get().plates.find((p) => p.id === 'plate-2')!.objects, activePlate: 'plate-2', slice: { status: 'idle' }, preview: null })
const runSlice = (host: Host, cx: unknown) => {
  const [cmd] = mimirCommands(host, [{ id: 'slice', title: 'Slice', section: 'slice', run: () => undefined }])
  return (cmd!.run as (i: unknown, cx: unknown) => Promise<unknown>)(undefined, cx)
}

beforeEach(() => {
  gates.profile = null
  gates.question = null
  gates.asked = 0
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [other], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, preview: null, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: {}, printerSlots: [], historyEdit: null, toast: null, printSheet: null, queue: [], projectGcode: null } as never)
})
afterEach(() => {
  gates.profile = null
  gates.question = null
})

describe("mimir's slice and a plate switch before the slice starts", () => {
  it('slices nothing when another plate shows while the profile loads, and says so', async () => {
    const e = engine()
    const g = gate()
    gates.profile = g.wait
    const cx = { sliced: vi.fn(), refused: vi.fn(), run: { fingerprint: () => 'f', update: vi.fn() } }
    const out = runSlice(e.host, cx)
    await new Promise((r) => setTimeout(r, 0))
    toPlate2()
    g.open()
    expect(await out).toEqual({ status: 'stale', message: SWITCHED_REPLY })
    expect(e.requests).toEqual([])
    expect(cx.sliced).not.toHaveBeenCalled()
    expect(cx.run.update).not.toHaveBeenCalled()
  })

  it('slices nothing when another plate shows while the project G-code question waits', async () => {
    const e = engine()
    set({ projectGcode: { source: 'Project.3mf', changes: [], asking: false } } as never)
    const g = gate()
    gates.question = g.wait
    const cx = { sliced: vi.fn(), refused: vi.fn() }
    const out = runSlice(e.host, cx)
    await vi.waitFor(() => expect(gates.asked).toBe(1))
    toPlate2()
    g.open()
    expect(await out).toEqual({ status: 'stale', message: SWITCHED_REPLY })
    expect(e.requests).toEqual([])
    expect(cx.sliced).not.toHaveBeenCalled()
  })

  it('does not record plate 2 as plate 1 when plate 2 slices and lands during the wait', async () => {
    const e = engine()
    const g = gate()
    gates.profile = g.wait
    const cx = { sliced: vi.fn(), refused: vi.fn() }
    const out = runSlice(e.host, cx)
    await new Promise((r) => setTimeout(r, 0))
    toPlate2()
    gates.profile = null
    // Plate 2 slices and lands (the slice counter moves) before mimir's wait ends.
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done', stamp: { plate: 'plate-2' } })
    g.open()
    expect(await out).toEqual({ status: 'stale', message: SWITCHED_REPLY })
    expect(cx.sliced).not.toHaveBeenCalled()
    expect(e.requests.map((r) => r.plate.objects.map((o) => o.id))).toEqual([['b']])
  })

  it('slicePlate with the plate asked for slices nothing once another plate shows, and slices it when it is shown', async () => {
    const e = engine()
    toPlate2()
    await slicePlate(e.host, { plate: 'plate-1' })
    expect(e.requests).toEqual([])
    await slicePlate(e.host, { plate: 'plate-2' })
    expect(e.requests).toHaveLength(1)
  })
})

describe('the waits between the sheet and a start', () => {
  /** Opens the sheet and confirms a start on it. */
  async function confirm(host: Host, printer: never) {
    set({ printSheet: null })
    const sent = sendToPrinter(host, printer)
    await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
    act(() => get().printSheet!.resolve({ name: get().printSheet!.name, options: {}, start: true } as never))
    return sent
  }

  it('leaves an uploaded file unstarted when the plan changes while it uploads, and says it is on the printer', async () => {
    const g = gate()
    const e = engine({ upload: g })
    await slicePlate(e.host)
    const sent = confirm(e.host, DEMO)
    await vi.waitFor(() => expect(g.reached).toBe(1))
    plan()
    g.open()
    await sent
    expect(e.uploads).toHaveLength(1)
    expect(e.started).toEqual([])
    expect(get().toast?.text).toBe(notStarted('Demo 1', e.uploads[0]!))
    expect(get().toast?.tone).toBe('error')
  })

  it('starts the uploaded file when nothing changed while it uploaded', async () => {
    const g = gate()
    const e = engine({ upload: g })
    await slicePlate(e.host)
    const sent = confirm(e.host, DEMO)
    await vi.waitFor(() => expect(g.reached).toBe(1))
    g.open()
    await sent
    expect(e.started).toHaveLength(1)
  })

  it('does not start locally when a plan is kept while the file is prepared', async () => {
    const g = gate()
    const e = engine({ hub: true, prepare: g })
    await slicePlate(e.host)
    const sent = confirm(e.host, PREPARED)
    await vi.waitFor(() => expect(g.reached).toBe(1))
    plan()
    g.open()
    await sent
    expect(e.local).toEqual([])
    expect(get().toast).toMatchObject({ text: SLICE_NOT_CURRENT, tone: 'error' })
  })

  it('does not start locally when another slice is on screen by then, with no plan', async () => {
    const g = gate()
    const e = engine({ hub: true, prepare: g })
    await slicePlate(e.host)
    const sent = confirm(e.host, PREPARED)
    await vi.waitFor(() => expect(g.reached).toBe(1))
    await slicePlate(e.host)
    g.open()
    await sent
    expect(e.local).toEqual([])
    expect(get().toast).toMatchObject({ text: STALE_SLICE, tone: 'error' })
  })

  it('starts locally when nothing changed while the file was prepared', async () => {
    const g = gate()
    const e = engine({ hub: true, prepare: g })
    await slicePlate(e.host)
    const sent = confirm(e.host, PREPARED)
    await vi.waitFor(() => expect(g.reached).toBe(1))
    g.open()
    await sent
    expect(e.local).toHaveLength(1)
  })
})

describe('export and a plate switch before the slice starts', () => {
  it('Export every plate exports nothing when another plate shows while a plate waits on the profile', async () => {
    const e = engine()
    const g = gate()
    gates.profile = g.wait
    const out = exportAllPlates(e.host)
    await new Promise((r) => setTimeout(r, 0))
    expect(get().activePlate).toBe('plate-1')
    switchPlate('plate-2')
    gates.profile = null
    g.open()
    expect(await out).toBe(false)
    expect(get().toast).toMatchObject({ text: `Plate 1: ${EXPORT_SWITCHED}`, tone: 'error' })
    expect(e.requests).toEqual([])
    expect(e.saved).toEqual([])
  })

  it('Export plate 3MF exports nothing when another plate shows while it waits on the profile, and exports when nothing switched', async () => {
    const e = engine()
    const g = gate()
    gates.profile = g.wait
    const out = exportGcode3mf(e.host)
    await new Promise((r) => setTimeout(r, 0))
    switchPlate('plate-2')
    gates.profile = null
    g.open()
    expect(await out).toBe(false)
    expect(get().toast).toMatchObject({ text: EXPORT_SWITCHED, tone: 'error' })
    expect(e.requests).toEqual([])
    expect(e.saved).toEqual([])
    expect(await exportGcode3mf(e.host)).toBe(true)
    expect(e.saved).toHaveLength(1)
  })
})
