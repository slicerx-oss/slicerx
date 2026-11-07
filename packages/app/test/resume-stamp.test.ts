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
import { QUEUED_NOT_CURRENT, queuedBlock, type QueueItem } from '../src/queue/queue'
import { exportGcode, sendToPrinter, slicePlate, startQueued } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'
import { ExportMenu } from '../src/workspaces/prepare/object-actions'

const part = { ...boxMesh(10, 10, 1), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 1], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
const other: PlateEntry = { ...box, id: 'b', name: 'Other' }
const BAY = { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu', nozzleCount: 1 } as never

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
function engine() {
  const requests: SliceRequest[] = []
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
      slice: async (req: SliceRequest) => {
        requests.push(req)
        if (sliceGate) await sliceGate
        return { id: `r${requests.length}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings: [], stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 } as unknown as SliceResult
      },
    },
    files: { save: async (name: string) => void saved.push(name) },
    printers: { status: async () => ({ state: 'idle' }), list: async () => [], start: async (...a: unknown[]) => void started.push(a) },
    approvals: {},
  } as unknown as Host
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
  return { host, requests, exported, saved, started, release, hold }
}

const plan = () => setResume(resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: [0.2, 0.3, 0.4, 0.5, 0.6] }))
const edit = () => set({ overrides: { ...get().overrides, wall_loops: Number(get().overrides['wall_loops'] ?? 2) + 1 } })
const toPlate2 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-1' ? { ...p, objects: get().plate } : p)), plate: get().plates.find((p) => p.id === 'plate-2')!.objects, activePlate: 'plate-2', slice: { status: 'idle' }, preview: null })
const toPlate1 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-2' ? { ...p, objects: get().plate } : p)), plate: get().plates.find((p) => p.id === 'plate-1')!.objects, activePlate: 'plate-1', slice: { status: 'idle' }, preview: null })
const sendable = () => printBlock(get()) === null && get().slice.status === 'done'
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
    go()
    await run
    expect(sendable()).toBe(false)
    expect(get().slicesDone).toBe(before)
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
    // The whole plate's own slice is the one that prints.
    await slicePlate(e.host)
    expect(e.requests.at(-1)!.options).not.toHaveProperty('resumeFromLayer')
    expect(sendable()).toBe(true)
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
    expect(sendable()).toBe(false)
    // A whole-plate slice that started before a plan was kept.
    set({ resume: null })
    go = e.hold()
    run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(3))
    set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 } }) })
    go()
    await run
    expect(e.release).toHaveBeenCalledWith('r3')
    expect(sendable()).toBe(false)
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
    expect(get().toast).toBeNull()
    go()
    await run
    expect(sendable()).toBe(false)
  })
})

describe('every route that sends, exports or queues checks the stamp', () => {
  /** A current whole-plate slice, then a plan kept for this plate without a new slice: the stamp no longer matches. */
  async function staleStamp(e: ReturnType<typeof engine>) {
    await slicePlate(e.host)
    expect(sendable()).toBe(true)
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
