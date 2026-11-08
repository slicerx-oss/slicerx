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
import { builtinCommands } from '../src/commands/builtin'
import { plateCommands } from '../src/plate/commands'
import { export3mfBlock, printBlock } from '../src/plate/heimdall'
import { boxMesh } from '../src/plate/mesh-ops'
import { needsSlice, planFor, printEverythingAgain, RESUME_VOID, resumeFor, resumeState, setResume, SLICE_NOT_CURRENT, sliceInputsKey } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { HELD_NOT_CURRENT, QUEUED_NOT_CURRENT, queuedBlock, type QueueItem } from '../src/queue/queue'
import { cancelSlice, exportGcode, sendToPrinter, slicePlate, STALE_SLICE, startQueued } from '../src/state/actions'
import { startAutoSlice } from '../src/state/auto-slice'
import { inputsChanged } from '../src/state/slice-inputs'
import { get, markStale, set, type PlateEntry } from '../src/state/store'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'
import { ExportMenu } from '../src/workspaces/prepare/object-actions'
import { SliceBlock } from '../src/workspaces/prepare/prepare-panes'
import { PreviewPlates } from '../src/workspaces/preview/preview-plates'
import { platesState } from '../src/app-link/plate-state'
import { collisionsReadback } from '../src/app-link/ui'
import { appState } from '../src/agent-bridge/page'
import { PlatePicker } from '../src/workspaces/prepare/plate-picker'

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
  const grants = { count: 0 }
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
        grants.count++
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
  return { host, requests, exported, saved, started, release, hold, signals, uploads, local, holdGrant, grants }
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
    // The plan changes only once the grant is waiting: past the sheet's own check.
    await vi.waitFor(() => expect(e.grants.count).toBe(1))
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
    expect(get().toast?.text).toContain('Other has no walls')
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
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }] } as never)
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    edit()
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    // No plan in play: a spool reload (grams left only) after it lands leaves it sendable, and its key as it was.
    const stamp = (get().slice as { stamp: { inputs: string } }).stamp
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10, spoolUid: 'new' }] } as never)
    expect(printBlock(get())).toBeNull()
    expect(sliceInputsKey(get())).toBe(stamp.inputs)
    // Another filament in the slot is an input.
    set({ printerSlots: [{ id: 'A1', material: 'PETG', color: '#fff', remainingG: 10 }] } as never)
    expect(sliceInputsKey(get())).not.toBe(stamp.inputs)
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

describe('round 16: what lands stale, and the routes under a plan', () => {
  it('lands a slice stale when a pause is added or an object renamed while it runs', async () => {
    const e = engine()
    let go = e.hold()
    let run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    set({ layerMarks: { 'plate-1': [{ id: 'm1', z: 0.6, kind: 'pause' }] } } as never)
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    go = e.hold()
    run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(3))
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    // A mark on another plate does not touch this one's G-code.
    await slicePlate(e.host)
    go = e.hold()
    run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(5))
    set({ layerMarks: { ...get().layerMarks, 'plate-2': [{ id: 'm2', z: 0.4, kind: 'pause' }] } } as never)
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
  })

  it('refuses every route after an edit under a plan with no markStale, and keeps the plan through a spool reload', async () => {
    const e = engine()
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }] } as never)
    plan()
    await slicePlate(e.host)
    expect(printBlock(get())).toBeNull()
    // A spool reload (grams left only) while the plan is kept: still the plate's slice for its plan.
    const stamp = (get().slice as { stamp: { inputs: string; plan: string | null } }).stamp
    expect(stamp.plan).toMatch(/^[0-9a-f]+$/)
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10 }] } as never)
    expect(printBlock(get())).toBeNull()
    expect(sliceInputsKey(get())).toBe(stamp.inputs)
    expect(planFor(get(), 'plate-1')).toBe(stamp.plan)
    // Another color in the slot voids the plan; the same spool back holds it again.
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#000', remainingG: 10 }] } as never)
    expect(planFor(get(), 'plate-1')).toBe(`void:${stamp.plan}`)
    expect(printBlock(get())).toBe(RESUME_VOID)
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10 }] } as never)
    expect(printBlock(get())).toBeNull()
    const queued: QueueItem = { id: 'q1', printerId: 'demo-1', printerName: 'Demo 1', plateName: 'Plate 1', remote: { name: 'plate.gcode' } as never, sha256: 'abc', layers: 1, timeS: 1, grams: 1, options: {} as never, addedAt: '2026-11-07T00:00:00Z', plate: 'plate-1', plan: planFor(get(), 'plate-1') }
    // An edit the slice does not hear of (auto slice off, no markStale).
    set({ overrides: { ...get().overrides, wall_loops: 5 } })
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    expect(printBlock(get())).toBe(RESUME_VOID)
    expect(await exportGcode3mf(e.host)).toBe(false)
    expect(e.saved).toEqual([])
    set({ toast: null } as never)
    await sendToPrinter(e.host, DEMO)
    expect(get().printSheet).toBeNull()
    expect(get().toast).toMatchObject({ text: RESUME_VOID, tone: 'error' })
    await startQueued(e.host, queued)
    expect(get().toast).toMatchObject({ text: QUEUED_NOT_CURRENT, tone: 'error' })
    expect(e.started).toEqual([])
  })

  it('puts a canceled reslice back with its own stamp, judged for its own plate when a plan is kept for another', async () => {
    const e = engine()
    await slicePlate(e.host)
    const stamp = (get().slice as { stamp?: unknown }).stamp
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, plate: 'plate-2', inputs: 'x' } })
    edit()
    set({ slice: { ...(get().slice as object), stale: true } as never })
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(2))
    cancelSlice({ quiet: true })
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: true, stamp })
    // Stale, so it does not go, but not as another plate's or plan's slice.
    expect(printBlock(get())).not.toBe(SLICE_NOT_CURRENT)
    await exportGcode(e.host)
    expect(get().toast).toMatchObject({ text: 'The plate changed after this slice. Slice it again first.' })
    expect(e.exported).toEqual([])
  })

  it('names the plate and the reason when the slice of a plate goes stale while every plate slices', async () => {
    const e = engine()
    const slice = e.host.slicer.slice.bind(e.host.slicer)
    ;(e.host.slicer as { slice: unknown }).slice = async (req: SliceRequest, o?: never) => {
      // Plate 2 is edited while it slices: a pause added.
      if (req.plate.objects.some((x) => x.id === 'b')) set({ layerMarks: { ...get().layerMarks, [get().activePlate]: [{ id: 'm', z: 0.4, kind: 'pause' }] } } as never)
      return slice(req, o)
    }
    expect(await exportAllPlates(e.host)).toBe(false)
    expect(get().toast?.text).toBe('Plate 2: The plate changed after this slice. Slice it again first.')
    expect(e.saved).toEqual([])
  })
})

describe('round 17: what goes into the G-code, before and after a slice lands', () => {
  const PROFILE = { printerId: 'bay-1', nozzle: 0.4, nozzles: [0.4], tier: 'standard', source: 'stock', shippedGcode: true, gcodeKeys: [], limits: {}, filamentIds: [], goalValues: {} }

  /** Slices with `during` run while the engine holds the slice, and returns whether it landed stale. */
  async function landsStale(e: ReturnType<typeof engine>, during: () => void): Promise<boolean> {
    const go = e.hold()
    const n = e.requests.length
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(n + 1))
    during()
    go()
    await run
    const sl = get().slice
    expect(sl.status).toBe('done')
    return (sl as { stale: boolean }).stale
  }

  it('lands stale for the G-code trust, a mark kind or text, and not for a color change slot or grams', async () => {
    const e = engine()
    set({ profile: PROFILE, printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }], layerMarks: { 'plate-1': [{ id: 'm1', z: 0.6, kind: 'custom', gcode: 'M117 a' }] } } as never)
    // The profile's G-code no longer trusted as shipped: the same profile otherwise.
    expect(await landsStale(e, () => set({ profile: { ...PROFILE, shippedGcode: false } } as never))).toBe(true)
    expect(await landsStale(e, () => set({ layerMarks: { 'plate-1': [{ id: 'm1', z: 0.6, kind: 'custom', gcode: 'M117 b' }] } } as never))).toBe(true)
    expect(await landsStale(e, () => set({ layerMarks: { 'plate-1': [{ id: 'm1', z: 0.6, kind: 'color_change', slot: 1 }] } } as never))).toBe(true)
    // A color change's slot is a note in the project, not part of the print.
    expect(await landsStale(e, () => set({ layerMarks: { 'plate-1': [{ id: 'm1', z: 0.6, kind: 'color_change', slot: 2 }] } } as never))).toBe(false)
    expect(await landsStale(e, () => set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 12 }] } as never))).toBe(false)
  })

  it('holds Print back once an object is renamed after a slice lands, with auto slice off, and Export plate 3MF slices again and saves', async () => {
    const e = engine()
    await slicePlate(e.host)
    expect(printBlock(get())).toBeNull()
    expect(needsSlice(get())).toBe(false)
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    expect(needsSlice(get())).toBe(true)
    expect(printBlock(get())).toBe(STALE_SLICE)
    await sendToPrinter(e.host, DEMO)
    expect(get().printSheet).toBeNull()
    expect(get().toast).toMatchObject({ text: STALE_SLICE, tone: 'error' })
    // Export plate 3MF slices first when needed: the rename is one such case.
    expect(await exportGcode3mf(e.host)).toBe(true)
    expect(e.requests).toHaveLength(2)
    expect(e.saved).toHaveLength(1)
    expect(needsSlice(get())).toBe(false)
    expect(printBlock(get())).toBeNull()
  })

  it('reads only the names of objects that print: renaming one set not to print holds nothing back, before or while it slices', async () => {
    const e = engine()
    set({ plate: [box, { ...box, id: 'c', name: 'Off', printable: false }] })
    await slicePlate(e.host)
    set({ plate: get().plate.map((p) => (p.id === 'c' ? { ...p, name: 'Still off' } : p)) })
    expect(needsSlice(get())).toBe(false)
    expect(printBlock(get())).toBeNull()
    const go = e.hold()
    const run = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(2))
    set({ plate: get().plate.map((p) => (p.id === 'c' ? { ...p, name: 'Off again' } : p)) })
    go()
    await run
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    // The one that prints still counts.
    set({ plate: get().plate.map((p) => (p.id === 'a' ? { ...p, name: 'Renamed' } : p)) })
    expect(printBlock(get())).toBe(STALE_SLICE)
  })

  it('keeps a slice current through a grams-only spool reload while its plate is out of view, with a tower spot per plate, and not through another color', async () => {
    const { switchPlate } = await import('../src/plate/plates')
    const { trackPlateSlices } = await import('../src/workspaces/preview/plate-slices')
    const stop = trackPlateSlices()
    try {
      const e = engine()
      // An opened project with a tower spot per plate: each switch back makes the plate's tower again, the same spot.
      set({ profile: null, printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }], towerFromProject: true, projectTowers: { 'plate-1': { x: 20, y: 30 }, 'plate-2': { x: 40, y: 50 } }, tower: { auto: false, x: 20, y: 30 } } as never)
      // The printer layer settles for these slots first, as it has long before a print in the app.
      await (await import('../src/state/profile-sync')).profileReady()
      await slicePlate(e.host)
      switchPlate('plate-2')
      set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10, spoolUid: 'new' }] } as never)
      switchPlate('plate-1')
      expect(get().slice).toMatchObject({ status: 'done', stale: false })
      expect(printBlock(get())).toBeNull()
      switchPlate('plate-2')
      set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#000', remainingG: 10 }] } as never)
      switchPlate('plate-1')
      expect(get().slice).toMatchObject({ status: 'done', stale: true })
    } finally {
      stop()
    }
  })

  it('reads a spool reload that changes only grams or the tag as no slice input, so auto slice leaves the slice current', async () => {
    const a = { ...get(), printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }] } as never
    expect(inputsChanged(a, { ...(a as object), printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10, spoolUid: 'x' }] } as never)).toBe(false)
    expect(inputsChanged(a, { ...(a as object), printerSlots: [{ id: 'A1', material: 'PETG', color: '#fff', remainingG: 900 }] } as never)).toBe(true)
    expect(inputsChanged(a, { ...(a as object), printerSlots: [{ id: 'A1', material: 'PLA', color: '#000', remainingG: 900 }] } as never)).toBe(true)
    expect(inputsChanged(a, { ...(a as object), printerSlots: [] } as never)).toBe(true)
    const e = engine()
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 900 }] } as never)
    await slicePlate(e.host)
    set({ autoSlice: true, autoSliceBySize: false, liveEdit: false, revealHold: false, exampleSeeding: false, plateLoading: false, sliceHeld: false } as never)
    const stop = startAutoSlice(e.host, 0)
    try {
      set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#fff', remainingG: 10 }] } as never)
      await new Promise((r) => setTimeout(r, 20))
      expect(get().slice).toMatchObject({ status: 'done', stale: false })
      expect(e.requests).toHaveLength(1)
      set({ printerSlots: [{ id: 'A1', material: 'PETG', color: '#fff', remainingG: 10 }] } as never)
      await vi.waitFor(() => expect(e.requests).toHaveLength(2))
    } finally {
      stop()
      set({ autoSlice: false } as never)
    }
  })
})

describe('round 19: the footer, the plate badges and the kept slices read the one stale rule', () => {
  it("keeps the footer's Export plate 3MF on after a rename, since it slices again first, and tags the estimate", async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(printBlock(get())).toBe(STALE_SLICE)
    render(wrap(e.host, createElement(SliceBlock, {})))
    act(() => screen.getByTestId('slice-output-menu').click())
    const item = screen.getByTestId('slice-output-export-3mf')
    expect(item.getAttribute('aria-disabled')).toBeNull()
    expect(screen.getByTestId('slice-estimate').querySelector('.app-tag.stale')?.textContent).toBe('Settings changed')
    // The export menu's item reads the same.
    cleanup()
    render(wrap(e.host, createElement(ExportMenu, { open: true, onClose: () => undefined })))
    expect(screen.getByTestId('export-gcode-3mf').getAttribute('aria-disabled')).toBeNull()
    // A click slices again, then saves.
    await act(async () => screen.getByTestId('export-gcode-3mf').click())
    await vi.waitFor(() => expect(e.saved).toHaveLength(1))
    expect(e.requests).toHaveLength(2)
  })

  it('keeps Export plate 3MF off in the export menu for a slice made for another plan', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    plan()
    expect(printBlock(get())).toBe(SLICE_NOT_CURRENT)
    render(wrap(e.host, createElement(ExportMenu, { open: true, onClose: () => undefined })))
    expect(screen.getByTestId('export-gcode-3mf').getAttribute('aria-disabled')).toBe('true')
  })

  it('shows a rename since the slice as Settings changed on the plate row and the Preview badge', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    expect(platesState().plates[0]!.slice).toBe('sliced')
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(platesState().plates[0]!.slice).toBe('stale')
    render(wrap(e.host, createElement(PreviewPlates)))
    expect(screen.getAllByRole('button')[0]!.querySelector('small')?.textContent).toBe('Settings changed')
  })

  it("reads a kept slice of an opened project's plate at that plate's own tower spot, as a switch back restores it", async () => {
    const { switchPlate } = await import('../src/plate/plates')
    const { keptSlice, trackPlateSlices } = await import('../src/workspaces/preview/plate-slices')
    const stop = trackPlateSlices()
    try {
      const e = engine()
      set({ profile: null, autoSlice: false, towerFromProject: true, projectTowers: { 'plate-1': { x: 20, y: 30 }, 'plate-2': { x: 40, y: 50 } }, tower: { auto: false, x: 20, y: 30 } } as never)
      await (await import('../src/state/profile-sync')).profileReady()
      switchPlate('plate-2')
      await slicePlate(e.host)
      switchPlate('plate-1')
      expect(keptSlice('plate-2')).toEqual({ stale: false })
      expect(platesState().plates[1]!.slice).toBe('sliced')
      switchPlate('plate-2')
      expect(get().slice).toMatchObject({ status: 'done', stale: false })
    } finally {
      stop()
    }
  })
})

describe('round 21: a slice already marked stale reads as before, whatever else changed in its G-code', () => {
  it('keeps Export G-code in the palette for a stale slice whose marks changed too, and running it says to slice again', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    set({ layerMarks: { 'plate-1': [{ id: 'm1', z: 0.6, kind: 'color_change', slot: 2 }] } } as never)
    await slicePlate(e.host)
    // Removing the mark changes what goes into the G-code and marks the slice stale, as the layer slider does.
    set({ layerMarks: { 'plate-1': [] } } as never)
    markStale()
    expect(get().slice).toMatchObject({ status: 'done', stale: true })
    expect(printBlock(get())).toBeNull()
    const cmd = builtinCommands(e.host, []).find((c) => c.id === 'export-gcode')!
    expect(cmd.enabled?.()).toBe(true)
    await cmd.run(undefined)
    expect(get().toast?.text).toBe(STALE_SLICE)
    expect(e.exported).toEqual([])
  })

  it('shows no red line in the footer for a stale slice after an object is added, only the tag', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    set({ plate: [...get().plate, other] })
    markStale()
    render(wrap(e.host, createElement(SliceBlock, {})))
    const footer = screen.getByTestId('slice-estimate')
    expect(footer.querySelector('.app-tag.stale')?.textContent).toBe('Settings changed')
    expect([...footer.querySelectorAll('.app-err')].map((p) => p.textContent)).toEqual([])
  })
})

describe('follow-up: a real block wins over the reslice Export plate 3MF does, and every reader agrees on a rename', () => {
  const HIT = { kind: 'nozzle', severity: 'hit', part: 'a', hitId: 'b', layer: 1, zMm: 0.2, depthMm: 0.4 }
  /** Puts a strike in the slice on screen, as heimdall reports one. */
  const strike = () => {
    const sl = get().slice
    if (sl.status !== 'done') throw new Error('no slice')
    set({ slice: { ...sl, result: { ...sl.result, collisions: [HIT] } } } as never)
  }
  const COLLISION = 'heimdall found a collision on this plate. See it in Slice, apply a fix or change the plate, and slice again.'

  it('keeps Export plate 3MF off with the collision when an object is renamed after a slice that struck', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    strike()
    expect(export3mfBlock(get())).toBe(COLLISION)
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(printBlock(get())).toBe(STALE_SLICE)
    expect(export3mfBlock(get())).toBe(COLLISION)
  })

  it('keeps the collision first the other way round too: a slice marked stale, then renamed', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    strike()
    markStale()
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(printBlock(get())).toBe(COLLISION)
    expect(export3mfBlock(get())).toBe(COLLISION)
  })

  it('still passes a rename with nothing else in the way, and keeps a slice already stale as any stale slice', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(printBlock(get())).toBe(STALE_SLICE)
    expect(export3mfBlock(get())).toBeNull()
    markStale()
    expect(printBlock(get())).toBeNull()
    expect(export3mfBlock(get())).toBeNull()
  })

  it("keeps a plan's own reason over the reslice pass", async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    plan()
    expect(export3mfBlock(get())).toBe(SLICE_NOT_CURRENT)
  })

  it('shows a rename since the slice as Settings changed on the plate picker', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    render(wrap(e.host, createElement(PlatePicker)))
    const current = () => screen.getByTestId('plate-picker-current').getAttribute('data-tip-body')
    expect(current()).toContain('sliced.')
    act(() => set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) }))
    expect(current()).toContain('settings changed.')
  })

  it('reads a rename since the slice as stale in the collision readback and leaves out its warnings in app_state', async () => {
    const e = engine()
    set({ autoSlice: false } as never)
    await slicePlate(e.host)
    const sl = get().slice
    if (sl.status !== 'done') throw new Error('no slice')
    set({ slice: { ...sl, result: { ...sl.result, warnings: [{ code: 'thin_wall', message: 'Thin wall' }] } } } as never)
    expect(collisionsReadback(get())?.stale).toBe(false)
    expect((appState(get()) as { plate: { warnings: { code: string }[] } }).plate.warnings.map((w) => w.code)).toEqual(['thin_wall'])
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(collisionsReadback(get())?.stale).toBe(true)
    expect((appState(get()) as { plate: { warnings: { code: string }[] } }).plate.warnings.map((w) => w.code)).toEqual([])
  })
})

