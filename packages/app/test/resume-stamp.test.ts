// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Every slice carries a stamp of what it was made for: the plate, the resume plan it used and the plate's inputs. A
// slice whose plate or plan changes while it runs is dropped as it lands, and every route that sends, exports or
// queues G-code compares the stamp with the plate as it is then. So a resume slice of plate 1 never lands as plate 2's,
// Print everything again or a new plan during a resume slice never leaves the old one sendable, a slice from before a
// plan never prints into the part on the bed, and a queued plate never starts under a plan it was not sliced for.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest, type SliceResult } from '@slicerx/contracts'
import { createPageBridge, installCapture, sliceSummary, type Capture } from '../src/agent-bridge'
import { EditionContext, NEUTRAL } from '../src/edition'
import { exportAllPlates, exportGcode3mf } from '../src/export/actions'
import { HostContext } from '../src/host'
import { plateCommands } from '../src/plate/commands'
import { printBlock } from '../src/plate/heimdall'
import { boxMesh } from '../src/plate/mesh-ops'
import { planFor, printEverythingAgain, RESUME_VOID, resumeFor, resumeState, setResume, SLICE_NOT_CURRENT, sliceInputsKey } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { HELD_NOT_CURRENT, QUEUED_NOT_CURRENT, queuedBlock, type QueueItem } from '../src/queue/queue'
import { cancelSlice, exportGcode, sendToPrinter, slicePlate, startQueued } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'
import { ExportMenu } from '../src/workspaces/prepare/object-actions'

const part = { ...boxMesh(10, 10, 1), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 1], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
const other: PlateEntry = { ...box, id: 'b', name: 'Other' }
const BAY = { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu', nozzleCount: 1 } as never
/** A printer that takes plain G-code, for the upload, queue and local start paths. */
const DEMO = { id: 'demo-1', name: 'Demo 1', vendor: 'Test', model: 'T1', plugin: 'demo', nozzleCount: 1 } as never
/** Opens the Print sheet for `printer` and answers it with `choice` once the test is ready (`before` runs first). */
async function sheet(host: Host, printer: never, choice: Record<string, unknown>, before: () => void | Promise<void> = () => undefined) {
  // The sheet's own UI clears it once answered; with none here, the last one goes first.
  set({ printSheet: null })
  const sent = sendToPrinter(host, printer)
  await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
  await before()
  const name = get().printSheet!.name ?? 'plate.gcode'
  act(() => get().printSheet!.resolve({ name, options: {}, ...choice } as never))
  await sent
}

/** A one-layer SXPV preview, enough for a slice to land. */
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

/**
 * A host whose slices land when the test says (it ignores a cancel, as an engine that finishes anyway does), whose
 * releases, exports, saves and printer starts are counted.
 */
function engine(opts: { hub?: boolean } = {}) {
  const requests: SliceRequest[] = []
  const signals: AbortSignal[] = []
  const uploads: string[] = []
  const local: boolean[] = []
  let grantGate: Promise<void> | null = null
  let plateCheck = 0
  const exported: string[] = []
  const saved: string[] = []
  const started: unknown[] = []
  const release = vi.fn()
  let sliceGate: Promise<void> | null = null
  let previewGate: Promise<void> | null = null
  const host = {
    kind: 'desktop',
    capabilities: { threads: 1 },
    slicer: {
      loadModel: async () => box.handle,
      release,
      getPreview: async () => {
        if (previewGate) await previewGate
        return rawPreview()
      },
      exportGcode: async (id: string) => (exported.push(id), { fileName: 'plate.gcode', bytes: 4, sha256: '', blob: new Blob(['G1\n']) }),
      slice: async (req: SliceRequest, o?: { signal?: AbortSignal }) => {
        requests.push(req)
        if (o?.signal) signals.push(o.signal)
        if (sliceGate) await sliceGate
        return { id: `r${requests.length}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings: [], stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 } as unknown as SliceResult
      },
    },
    files: { save: async (name: string) => void saved.push(name) },
    printers: {
      status: async () => ({ state: 'idle' }),
      list: async () => [],
      start: async (...a: unknown[]) => void started.push(a),
      upload: async (_id: string, file: { name: string }) => (uploads.push(file.name), { printerId: 'demo-1', path: `/${file.name}`, name: file.name }),
      ...(opts.hub
        ? {
            bed: { state: async () => ({ state: 'unknown' }) },
            // The first start meets something on the plate (the plate guard holds it); later ones go.
            printLocal: async (_id: string, file: { name: string }, _o: unknown, _b: boolean, _x: unknown, plateOk: boolean) => {
              if (!plateOk && plateCheck++ === 0) throw Object.assign(new Error('something on the plate'), { code: 'plate_check' })
              local.push(plateOk)
              void file
            },
          }
        : {}),
    },
    approvals: {
      register: async () => undefined,
      grant: async (id: string) => {
        if (grantGate) await grantGate
        return { id, token: 't' }
      },
    },
  } as unknown as Host
  /** Holds approval grants until the returned function is called. */
  const holdGrant = () => {
    let go = () => undefined as void
    grantGate = new Promise<void>((res) => (go = res))
    return () => {
      grantGate = null
      go()
    }
  }
  /** Holds slices (or previews) from now until the returned function is called. */
  const hold = (what: 'slice' | 'preview' = 'slice') => {
    let go = () => undefined as void
    const gate = new Promise<void>((res) => (go = res))
    if (what === 'slice') sliceGate = gate
    else previewGate = gate
    return () => {
      if (what === 'slice') sliceGate = null
      else previewGate = null
      go()
    }
  }
  return { host, requests, exported, saved, started, release, hold, signals, uploads, local, holdGrant }
}

const plan = () => setResume(resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: [0.2, 0.3, 0.4, 0.5, 0.6] }))
const edit = () => set({ overrides: { ...get().overrides, wall_loops: Number(get().overrides['wall_loops'] ?? 2) + 1 } })
const toPlate2 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-1' ? { ...p, objects: get().plate } : p)), plate: get().plates.find((p) => p.id === 'plate-2')!.objects, activePlate: 'plate-2', slice: { status: 'idle' }, preview: null })
const toPlate1 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-2' ? { ...p, objects: get().plate } : p)), plate: get().plates.find((p) => p.id === 'plate-1')!.objects, activePlate: 'plate-1', slice: { status: 'idle' }, preview: null })
const wrap = (host: Host, el: ReturnType<typeof createElement>) => createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: host }, createElement(EditionContext.Provider, { value: NEUTRAL }, el)))

let capture: Capture | null = null
beforeEach(() => {
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [other], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, preview: null, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: {}, printerSlots: [], historyEdit: null, toast: null, printSheet: null, queue: [] } as never)
})
afterEach(() => {
  capture?.stop()
  capture = null
  cleanup()
})

describe('a slice whose plate or plan changes while it runs', () => {
  it("drops plate 1's resume slice when plate 2 shows before it lands, and plate 2 has nothing to send", async () => {
    const e = engine()
    plan()
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    expect(e.requests[0]!.options).toMatchObject({ resumeFromLayer: 2 })
    toPlate2()
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r1')
    expect(get().slice).toEqual({ status: 'idle' })
    expect(get().preview).toBeNull()
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
  })

  it("drops a whole-plate slice of plate 1 the same way when plate 2 shows", async () => {
    const e = engine()
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    toPlate2()
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r1')
    expect(get().slice.status).toBe('idle')
  })

  it('cancels a running resume slice on Print everything again, and drops it if it lands anyway', async () => {
    const e = engine()
    plan()
    const before = get().slicesDone
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    printEverythingAgain()
    expect(get().resume).toBeNull()
    expect(e.signals[0]!.aborted).toBe(true)
    go()
    await run
    expect(get().slice).toEqual({ status: 'idle' })
    expect(get().slicesDone).toBe(before)
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
    // The whole plate's own slice is the one that prints.
    await slicePlate(e.host)
    expect(e.requests.at(-1)!.options).not.toHaveProperty('resumeFromLayer')
    expect(get().slice).toMatchObject({ status: 'done', stale: false, stamp: { plate: 'plate-1', plan: null } })
    expect(printBlock(get())).toBeNull()
  })

  it('drops a resume slice when the plan is cleared or replaced without a cancel (the landing check alone)', async () => {
    const e = engine()
    plan()
    let go = e.hold()
    let run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    set({ resume: null })
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r1')
    expect(get().slice).toEqual({ status: 'idle' })
    // Replaced by another plan while it ran.
    plan()
    go = e.hold()
    run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(2))
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 3, printedHeightMm: 0.6 }, layerTopsMm: [0.2, 0.3, 0.4, 0.5, 0.6] }) })
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r2')
    expect(get().slice).toEqual({ status: 'idle' })
    // A whole-plate slice that started before a plan was kept.
    set({ resume: null })
    go = e.hold()
    run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(3))
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 } }) })
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r3')
    expect(get().slice).toEqual({ status: 'idle' })
  })

  it('refuses a resume slice an edit voided while it ran, with no preview, no count and nothing exported', async () => {
    const e = engine()
    plan()
    const before = get().slicesDone
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    edit()
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r1')
    expect(get().slice).toEqual({ status: 'error', message: RESUME_VOID, code: 'resume_void' })
    expect(get().preview).toBeNull()
    expect(get().slicesDone).toBe(before)
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
  })

  it('refuses it the same way when the edit comes after the engine answered, while the preview loads', async () => {
    const e = engine()
    plan()
    const go = e.hold('preview')
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 0))
    edit()
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r1')
    expect(get().slice).toMatchObject({ status: 'error', code: 'resume_void' })
    expect(get().preview).toBeNull()
  })

  it('cancels a running slice quietly when a plan is stored', async () => {
    const e = engine()
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    plan()
    // Canceled at once, before the engine answers.
    expect(e.signals[0]!.aborted).toBe(true)
    expect(get().toast).toBeNull()
    go()
    await run
    expect(get().slice.status).not.toBe('running')
    expect(get().slice).toEqual({ status: 'idle' })
    expect(get().toast).toBeNull()
  })
})

describe('every route that sends, exports or queues checks the stamp', () => {
  /** A current whole-plate slice, then a plan kept for this plate without a new slice: the stamp no longer matches. */
  async function staleStamp(e: ReturnType<typeof engine>) {
    await slicePlate(e.host)
    expect(printBlock(get())).toBeNull()
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 } }) })
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    expect(printBlock(get())).toBe(SLICE_NOT_CURRENT)
  }

  it('Export G-code', async () => {
    const e = engine()
    await staleStamp(e)
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
    expect(get().toast).toMatchObject({ text: SLICE_NOT_CURRENT, tone: 'error' })
    await slicePlate(e.host)
    await exportGcode(e.host)
    expect(e.exported).toHaveLength(1)
  })

  it('Export plate 3MF', async () => {
    const e = engine()
    await staleStamp(e)
    expect(await exportGcode3mf(e.host)).toBe(false)
    expect(e.exported).toEqual([])
    await slicePlate(e.host)
    expect(await exportGcode3mf(e.host)).toBe(true)
    expect(e.saved).toHaveLength(1)
  })

  it('Print on a printer, before the sheet and when the plan changes while the sheet is open', async () => {
    const e = engine()
    await staleStamp(e)
    await sendToPrinter(e.host, BAY)
    expect(get().printSheet).toBeNull()
    expect(get().toast).toMatchObject({ text: SLICE_NOT_CURRENT, tone: 'error' })
    await slicePlate(e.host)
    const sent = sendToPrinter(e.host, BAY)
    await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
    // Print everything again while the sheet is open: the confirm sends nothing.
    printEverythingAgain()
    act(() => get().printSheet!.resolve({ options: {} } as never))
    await sent
    expect(get().printSheet).toBeNull()
    expect(get().toast?.tone).toBe('error')
    expect(e.started).toEqual([])
  })

  it('Export every plate', async () => {
    const e = engine()
    await staleStamp(e)
    expect(await exportAllPlates(e.host)).toBe(false)
    expect(e.saved).toEqual([])
    set({ resume: null })
    expect(await exportAllPlates(e.host)).toBe(true)
    expect(e.saved).toHaveLength(1)
  })

  it('a queued plate starts only under the plan its slice used', async () => {
    const e = engine()
    const item: QueueItem = { id: 'q1', printerId: 'bay-1', printerName: 'Bay 1', plateName: 'Plate 1', remote: { name: 'plate.gcode' } as never, sha256: 'abc', layers: 1, timeS: 1, grams: 1, options: {} as never, addedAt: '2026-11-07T00:00:00Z', plate: 'plate-1', plan: null }
    expect(queuedBlock(get(), item)).toBeNull()
    plan()
    expect(queuedBlock(get(), item)).toBe(QUEUED_NOT_CURRENT)
    await startQueued(e.host, item)
    expect(get().toast).toMatchObject({ text: QUEUED_NOT_CURRENT, tone: 'error' })
    expect(e.started).toEqual([])
    // Sliced and queued under this plan: it may start. A plan for another plate holds nothing for it.
    expect(queuedBlock(get(), { ...item, plan: planFor(get(), 'plate-1') })).toBeNull()
    expect(queuedBlock(get(), { ...item, plate: 'plate-2' })).toBeNull()
    // Voided since: it does not.
    const queuedPlan = planFor(get(), 'plate-1')
    edit()
    expect(queuedBlock(get(), { ...item, plan: queuedPlan })).toBe(QUEUED_NOT_CURRENT)
    // An item from before queue items named their plate starts only while no plan is kept.
    const { plate: _p, plan: _q, ...old } = item
    expect(queuedBlock(get(), old as QueueItem)).toBe(QUEUED_NOT_CURRENT)
    printEverythingAgain()
    expect(queuedBlock(get(), old as QueueItem)).toBeNull()
  })

  it("mimir's printer.queue: the plate's fingerprint changes when its plan is kept, cleared, replaced or voided, and not for another plate's", () => {
    const f0 = plateFingerprint(get(), 1)
    const p2 = plateFingerprint(get(), 2)
    plan()
    const f1 = plateFingerprint(get(), 1)
    expect(f1).not.toBe(f0)
    expect(plateFingerprint(get(), 2)).toBe(p2)
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 3, printedHeightMm: 0.6 } }) })
    const f2 = plateFingerprint(get(), 1)
    expect(f2).not.toBe(f1)
    // Voided by a change the fingerprint does not read on its own (paint).
    set({ plate: get().plate.map((p) => ({ ...p, paint: { 0: { color: { 0: '8' } } } })) })
    expect(plateFingerprint(get(), 1)).not.toBe(f2)
    printEverythingAgain()
    // Read while plate 2 shows: plate 1's plan still counts for plate 1.
    plan()
    const kept = plateFingerprint(get(), 1)
    toPlate2()
    expect(plateFingerprint(get(), 1)).toBe(kept)
    toPlate1()
  })

  it('the bridge: export_info refuses a slice from before the plan, and a refused slice carries resume_void', async () => {
    const e = engine()
    await staleStamp(e)
    capture = installCapture(window)
    const bridge = createPageBridge(capture)
    bridge.attach({} as never)
    await expect(bridge.handle('export_info', {})).rejects.toMatchObject({ code: 'refused', message: SLICE_NOT_CURRENT })
    edit()
    await expect(bridge.handle('export_info', {})).rejects.toMatchObject({ code: 'refused', message: RESUME_VOID })
    await slicePlate(e.host)
    expect(sliceSummary(get())).toMatchObject({ status: 'error', code: 'resume_void', message: RESUME_VOID })
    const state = (await bridge.handle('state', {})) as Record<string, unknown>
    expect(state['resume']).toEqual({ kept: true, plate: 1, holds: false })
    expect(resumeState(get())).toEqual({ kept: true, plate: 1, holds: false })
  })
})

describe('Export every plate while a plan is kept, in its command and menu', () => {
  it('is turned off in the command and the menu with the reason, and back on once the plan is cleared', () => {
    plan()
    const cmd = plateCommands(() => ({}) as never, engine().host).find((c) => c.id === 'export-all-plates')!
    expect(cmd.enabled?.()).toBe(false)
    render(wrap(engine().host, createElement(ExportMenu, { open: true, onClose: () => undefined })))
    const item = screen.getByTestId('export-all-plates')
    expect(item.getAttribute('aria-disabled')).toBe('true')
    expect(item.getAttribute('data-tip-reason')).toBe('A resume plan is kept for plate 1. Print that plate on its own, or choose Print everything again first.')
    act(() => printEverythingAgain())
    expect(cmd.enabled?.()).toBe(true)
    expect(screen.getByTestId('export-all-plates').getAttribute('aria-disabled')).toBeNull()
  })

  it('says a plan is kept with no plate number when its plate is gone', () => {
    plan()
    set({ plates: get().plates.filter((p) => p.id === 'plate-2'), activePlate: 'plate-2', plate: [other] })
    const cmd = plateCommands(() => ({}) as never, engine().host).find((c) => c.id === 'export-all-plates')!
    expect(cmd.enabled?.()).toBe(false)
    render(wrap(engine().host, createElement(ExportMenu, { open: true, onClose: () => undefined })))
    expect(screen.getByTestId('export-all-plates').getAttribute('data-tip-reason')).toBe('A resume plan is kept. Print that plate on its own, or choose Print everything again first.')
  })
})

describe('the key', () => {
  it('stays the same when an object is turned off and on again, and for printable set to undefined', () => {
    const k = sliceInputsKey(get())
    set({ plate: get().plate.map((p) => ({ ...p, printable: false })) })
    expect(sliceInputsKey(get())).not.toBe(k)
    set({ plate: get().plate.map((p) => ({ ...p, printable: true })) })
    expect(sliceInputsKey(get())).toBe(k)
    set({ plate: get().plate.map((p) => ({ ...p, printable: undefined }) as never) })
    expect(sliceInputsKey(get())).toBe(k)
  })

  it("counts the settings an instance reads from its source on another plate", () => {
    // Plate 2 holds an instance of plate 1's object; the slice reads the source's settings for it.
    set({ plates: get().plates.map((p) => (p.id === 'plate-2' ? { ...p, objects: [{ ...box, id: 'a~1', instanceOf: 'a' }] } : p)) })
    toPlate2()
    const k = sliceInputsKey(get())
    set({ objectSettings: { a: { wall_loops: 5 } } })
    expect(sliceInputsKey(get())).not.toBe(k)
  })
})

describe('round 15: the send paths after their waits', () => {
  it('a queued plate takes its plate and plan from the slice it was sliced as', async () => {
    const e = engine()
    await slicePlate(e.host)
    await sheet(e.host, DEMO, { start: false, queue: {} })
    expect(e.uploads).toHaveLength(1)
    expect(get().queue.at(-1)).toMatchObject({ plate: 'plate-1', plan: null })
    // Under a resume plan that holds: its id.
    plan()
    await slicePlate(e.host)
    const id = planFor(get(), 'plate-1')
    expect(id).not.toBeNull()
    await sheet(e.host, DEMO, { start: false, queue: {} })
    const item = get().queue.at(-1)!
    expect(item).toMatchObject({ plate: 'plate-1', plan: id })
    expect(queuedBlock(get(), item)).toBeNull()
    // A plan kept for the first item's plate afterward: that item does not start.
    const first = get().queue[0]!
    await startQueued(e.host, first)
    expect(get().toast).toMatchObject({ text: QUEUED_NOT_CURRENT, tone: 'error' })
    expect(e.started).toEqual([])
  })

  it('a queued start the plan changed under while the approval card was open does not start', async () => {
    const e = engine()
    await slicePlate(e.host)
    await sheet(e.host, DEMO, { start: false, queue: {} })
    const item = get().queue[0]!
    const starting = startQueued(e.host, item)
    await vi.waitFor(() => expect(get().approval).not.toBeNull())
    plan()
    await act(async () => get().approval!.approve())
    await starting
    expect(e.started).toEqual([])
    expect(get().toast).toMatchObject({ text: QUEUED_NOT_CURRENT, tone: 'error' })
    expect(get().queue).toHaveLength(1)
  })

  it('the Print sheet confirm refuses a slice whose plan changed without making it stale, by its stamp', async () => {
    const e = engine()
    await slicePlate(e.host)
    await sheet(e.host, DEMO, { start: true }, () => set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 } }) }))
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    expect(get().toast).toMatchObject({ text: SLICE_NOT_CURRENT, tone: 'error' })
    expect(e.uploads).toEqual([])
    expect(e.started).toEqual([])
  })

  it('an upload the plan changed under while the approval was granted does not go', async () => {
    const e = engine()
    await slicePlate(e.host)
    const go = e.holdGrant()
    const sent = sendToPrinter(e.host, DEMO)
    await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
    act(() => get().printSheet!.resolve({ name: get().printSheet!.name, options: {}, start: true } as never))
    await new Promise((r) => setTimeout(r, 20))
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 } }) })
    go()
    await sent
    expect(e.uploads).toEqual([])
    expect(e.started).toEqual([])
    expect(get().toast).toMatchObject({ text: SLICE_NOT_CURRENT, tone: 'error' })
  })

  it('a start the plate guard held does not go later under a plan its file was not sliced for', async () => {
    const { heldStart, resetGuard } = await import('../src/features/fleet/guard')
    resetGuard()
    const e = engine({ hub: true })
    await slicePlate(e.host)
    await sheet(e.host, DEMO, { start: true })
    expect(e.local).toEqual([])
    const again = heldStart('demo-1')
    expect(again).not.toBeNull()
    // Started later from the Printers tab, after a plan was kept for the plate: it does not go.
    plan()
    set({ toast: null } as never)
    await again!()
    expect(e.local).toEqual([])
    expect(get().toast).toMatchObject({ text: HELD_NOT_CURRENT, tone: 'error' })
    // With the plan cleared again, the held file is the plate's whole print and goes.
    printEverythingAgain()
    await again!()
    expect(e.local).toEqual([true])
    resetGuard()
  })
})

describe('round 15: a stale slice and Export plate 3MF', () => {
  it('does not export the last slice when the reslice is canceled while a plan is kept', async () => {
    const e = engine()
    await slicePlate(e.host)
    plan()
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    const go = e.hold()
    const exporting = exportGcode3mf(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(2))
    cancelSlice({ quiet: true })
    go()
    expect(await exporting).toBe(false)
    expect(e.saved).toEqual([])
    expect(e.exported).toEqual([])
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    expect(get().toast).toMatchObject({ text: SLICE_NOT_CURRENT, tone: 'error' })
  })

  it('does not export a stale slice with no plan either, and says to slice first', async () => {
    const e = engine()
    await slicePlate(e.host)
    edit()
    set({ slice: { ...(get().slice as object), stale: true } as never })
    const go = e.hold()
    const exporting = exportGcode3mf(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(2))
    cancelSlice({ quiet: true })
    go()
    expect(await exporting).toBe(false)
    expect(e.saved).toEqual([])
    expect(get().toast).toMatchObject({ text: 'Slice the plate first.' })
  })
})

describe('round 15: Export every plate says why a plate stopped it', () => {
  it('writes a plate whose slice has a strike, as before, and names the plate and the reason when one fails', async () => {
    const e = engine()
    const slice = e.host.slicer.slice.bind(e.host.slicer)
    let failPlate2 = false
    ;(e.host.slicer as { slice: unknown }).slice = async (req: SliceRequest, o?: never) => {
      const out = await slice(req, o)
      if (req.plate.objects.some((x) => x.id === 'b')) {
        if (failPlate2) throw new Error('The slicer stopped: Other has no walls.')
        return { ...out, collisions: [{ kind: 'gantry', severity: 'hit', part: 'gantry', objectId: 'b', hitId: 'b', layer: 0, segment: 0, timeS: 0, at: [0, 0, 0], point: [0, 0, 0] }] }
      }
      return out
    }
    expect(await exportAllPlates(e.host)).toBe(true)
    expect(e.saved).toHaveLength(1)
    failPlate2 = true
    set({ toast: null } as never)
    expect(await exportAllPlates(e.host)).toBe(false)
    expect(get().toast?.text).toMatch(/^Plate 2: /)
    expect(get().toast?.text).not.toMatch(/did not slice/)
  })
})

describe('round 15: plans and plates', () => {
  it('reads a plan that holds as holding while another plate with its own project tower shows', async () => {
    const { switchPlate } = await import('../src/plate/plates')
    set({ towerFromProject: true, projectTowers: { 'plate-1': { x: 20, y: 20 }, 'plate-2': { x: 150, y: 150 } }, tower: { auto: false, x: 20, y: 20 } } as never)
    plan()
    const id = planFor(get(), 'plate-1')
    expect(id).not.toMatch(/^void:/)
    switchPlate('plate-2')
    expect(get().tower).toMatchObject({ x: 150, y: 150 })
    expect(planFor(get(), 'plate-1')).toBe(id)
    expect(resumeState(get())).toEqual({ kept: true, plate: 1, holds: true })
    switchPlate('plate-1')
    expect(planFor(get(), 'plate-1')).toBe(id)
  })

  it('refuses a kept slice put back on a plate switch after its plan was cleared', async () => {
    const { switchPlate } = await import('../src/plate/plates')
    const { trackPlateSlices } = await import('../src/workspaces/preview/plate-slices')
    const stop = trackPlateSlices()
    try {
      const e = engine()
      plan()
      await slicePlate(e.host)
      expect(get().slice).toMatchObject({ status: 'done', stamp: { plate: 'plate-1' } })
      expect(printBlock(get())).toBeNull()
      switchPlate('plate-2')
      printEverythingAgain()
      switchPlate('plate-1')
      expect(get().slice).toMatchObject({ status: 'done', stamp: { plate: 'plate-1' } })
      expect(printBlock(get())).toBe(SLICE_NOT_CURRENT)
      await exportGcode(e.host)
      expect(e.exported).toEqual([])
    } finally {
      stop()
    }
  })

  it('lands a slice stale when an edit came while it ran, and keeps a landed one sendable through a change the key leaves out', async () => {
    const e = engine()
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    edit()
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    // No plan in play: a spool reload (grams left) after it lands leaves it sendable.
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10 }] } as never)
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }] } as never)
    expect(printBlock(get())).toBeNull()
  })

  it("mimir's run reads its slice as stale once a plan is kept for the plate, through the app's own fingerprint", async () => {
    const { createRunBook, runHandle } = await import('@slicerx/pilot')
    const { appPrintRun } = await import('../src/workspaces/mimir/print-run')
    const book = createRunBook(appPrintRun(), () => 0)
    const run = runHandle(book, 's')
    run.update({ printerId: 'bay-1', slots: {}, plate: 1, slice: { sliceId: 'r1', plate: 1, at: '', timeS: 1, grams: 1, cost: 0, warnings: [], fingerprint: run.fingerprint(1), stale: false } })
    expect(run.get().slice!.stale).toBe(false)
    plan()
    expect(run.get().slice!.stale).toBe(true)
  })

  it("mimir's slice says another plate showed when its own slice was dropped", async () => {
    const { mimirCommands, SWITCHED_REPLY } = await import('../src/workspaces/mimir/session')
    const e = engine()
    const [cmd] = mimirCommands(e.host, [{ id: 'slice', title: 'Slice', section: 'slice', run: () => undefined }])
    const go = e.hold()
    const out = (cmd!.run as (i: unknown, cx: unknown) => Promise<unknown>)(undefined, { sliced: vi.fn(), refused: vi.fn() })
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    // Plate 2 shows with a slice of its own already on screen.
    toPlate2()
    set({ slice: { status: 'done', result: { id: 'p2', warnings: [], stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 } }, stale: false } as never })
    go()
    expect(await out).toEqual({ status: 'stale', message: SWITCHED_REPLY })
  })
})

describe('round 15: the queue keeps its stamp through a restart', () => {
  it('saves and loads plate and plan', async () => {
    const { normalizePrefs } = await import('../src/state/prefs')
    const base = { id: 'q1', printerId: 'p1', printerName: 'Bay 1', plateName: 'Plate 1', remote: { printerId: 'p1', path: '/a.gcode', name: 'a.gcode' }, sha256: 'abc', layers: 1, timeS: 1, grams: 1, options: {}, addedAt: '2026-11-07T00:00:00Z' }
    const back = normalizePrefs(JSON.parse(JSON.stringify({ queue: [{ ...base, plate: 'plate-1', plan: 'abcd1234' }, { ...base, id: 'q2', plate: 'plate-2', plan: null }, { ...base, id: 'q3' }] })))
    expect(back.queue![0]).toMatchObject({ plate: 'plate-1', plan: 'abcd1234' })
    expect(back.queue![1]).toMatchObject({ plate: 'plate-2', plan: null })
    expect(back.queue![2]).not.toHaveProperty('plate')
  })
})
