// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A resume plan kept for the shown plate that no longer matches it (the plate changed since) holds for none of it, and
// the plate must not quietly print whole into the part on the bed: slicePlate refuses (one chokepoint for the Slice
// button, auto slice, Export all plates, mimir and the print queue), and Print and Export wait with one message until
// the plan is made again or cleared (Print everything again). A plan kept for another plate holds nothing there: that
// plate prints in full, with a note naming the plan's plate. Preview's "Resumes at" line, its Export and the dialog's
// banners follow the same rule, and a spool reload or a rename keeps the plan.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPreview, SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest, type SliceResult } from '@slicerx/contracts'
import { EditionContext, NEUTRAL } from '../src/edition'
import { getCommand, isEnabled } from '../src/commands/registry'
import { exportAllPlates, exportGcode3mf } from '../src/export/actions'
import { HostContext } from '../src/host'
import { printBlock } from '../src/plate/heimdall'
import { boxMesh } from '../src/plate/mesh-ops'
import { ResumeDialog } from '../src/plate/resume-dialog'
import { closeResume, openResume, useResumeAsk } from '../src/plate/resume-state'
import { activeResume, exportAllBlock, printEverythingAgain, RESUME_VOID, resumeElsewhere, resumeFor, resumeVoid, sliceInputsKey } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { exportGcode, sendToPrinter, slicePlate } from '../src/state/actions'
import { get, set, type PlateEntry } from '../src/state/store'
import { mimirCommands } from '../src/workspaces/mimir/session'
import { SliceBlock } from '../src/workspaces/prepare/prepare-panes'
import { PreviewLeft, PreviewRight } from '../src/workspaces/preview/preview-panes'

HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open')
}

const part = { ...boxMesh(10, 10, 1), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 1], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
/** Plate 2's own object, for another printer. */
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

/** A host whose slices land with `warnings`, whose G-code export and saves are counted, and whose printer answers. */
function engine(warnings: SliceResult['warnings'] = []) {
  const requests: SliceRequest[] = []
  const exported: string[] = []
  const saved: string[] = []
  let hold: Promise<void> | null = null
  const host = {
    kind: 'desktop',
    capabilities: { threads: 1 },
    slicer: {
      loadModel: async () => box.handle,
      release: () => undefined,
      getPreview: async () => rawPreview(),
      exportGcode: async (id: string) => (exported.push(id), { fileName: 'plate.gcode', bytes: 4, sha256: '', blob: new Blob(['G1\n']) }),
      slice: async (req: SliceRequest) => {
        requests.push(req)
        if (hold) await hold
        return { id: `r${requests.length}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings, stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 } as unknown as SliceResult
      },
    },
    files: { save: async (name: string) => void saved.push(name) },
    printers: { status: async () => null },
    approvals: {},
  } as unknown as Host
  /** Holds the next slices until the returned function is called. */
  const holdSlices = () => {
    let go = () => undefined as void
    hold = new Promise<void>((res) => (go = res))
    return () => ((hold = null), go())
  }
  return { host, requests, exported, saved, holdSlices }
}

/** Stores a plan for the shown plate as it is, as Slice the rest does. */
const plan = () => set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: [0.2, 0.3, 0.4, 0.5, 0.6] }) })
const edit = () => set({ overrides: { ...get().overrides, wall_loops: Number(get().overrides['wall_loops'] ?? 2) + 1 } })
const toPlate2 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-1' ? { ...p, objects: get().plate } : p)), plate: [other], activePlate: 'plate-2', slice: { status: 'idle' }, preview: null })
const toPlate1 = () => set({ plates: get().plates.map((p) => (p.id === 'plate-2' ? { ...p, objects: get().plate } : p)), plate: get().plates.find((p) => p.id === 'plate-1')!.objects, activePlate: 'plate-1', slice: { status: 'idle' }, preview: null })
const wrap = (host: Host, el: ReturnType<typeof createElement>) => createElement(QueryClientProvider, { client: new QueryClient() }, createElement(HostContext.Provider, { value: host }, createElement(EditionContext.Provider, { value: NEUTRAL }, el)))

beforeEach(() => {
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [other], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, preview: null, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: {}, printerSlots: [], historyEdit: null, toast: null, printSheet: null } as never)
})
afterEach(() => {
  act(() => closeResume())
  cleanup()
})

describe('Print and Export with a resume plan that no longer matches', () => {
  it('wait with one message after an edit, and go again once the plan is made again or cleared', async () => {
    const e = engine()
    plan()
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    expect(printBlock(get())).toBeNull()
    edit()
    expect(printBlock(get())).toBe(RESUME_VOID)
    // The slice on screen is from before the edit: nothing leaves.
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
    expect(get().toast).toMatchObject({ text: RESUME_VOID, tone: 'error' })
    // Export plate 3MF and Print on a printer wait the same way.
    expect(await exportGcode3mf(e.host)).toBe(false)
    set({ toast: null } as never)
    await sendToPrinter(e.host, BAY)
    expect(get().toast).toMatchObject({ text: RESUME_VOID, tone: 'error' })
    expect(get().printSheet).toBeNull()
    expect(e.exported).toEqual([])
    // Planned again for the plate as it is now: Print and Export go.
    plan()
    expect(printBlock(get())).toBeNull()
    // Cleared with Print everything again: they go, for the whole plate.
    edit()
    expect(printBlock(get())).toBe(RESUME_VOID)
    printEverythingAgain()
    expect(get().resume).toBeNull()
    expect(printBlock(get())).toBeNull()
    await slicePlate(e.host)
    expect(e.requests.at(-1)!.options).not.toHaveProperty('resumeFromLayer')
    await exportGcode(e.host)
    expect(e.exported).toHaveLength(1)
  })

  it('keep going through a spool reload, a rename, a lock and a new thumbnail', () => {
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#ffffff', remainingG: 600, remainingPct: 60, spoolUid: 'tag-1', spoolmanId: 3 }] })
    plan()
    set({ printerSlots: [{ id: 'A1', material: 'PLA', color: '#ffffff', remainingG: 980, remainingPct: 98, spoolUid: 'tag-2', spoolmanId: 4 }] })
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed', locked: true, thumb: 'data:image/png;base64,AA' })) })
    expect(activeResume(get())).not.toBeNull()
    expect(printBlock(get())).toBeNull()
  })
})

describe('slicePlate with a kept plan that no longer matches its plate', () => {
  it('refuses: an error that names the plan, no preview, nothing sent to the engine and nothing to send', async () => {
    const e = engine()
    plan()
    await slicePlate(e.host)
    expect(e.requests).toHaveLength(1)
    edit()
    await slicePlate(e.host)
    expect(e.requests).toHaveLength(1)
    expect(get().slice).toEqual({ status: 'error', message: RESUME_VOID, code: 'resume_void' })
    expect(get().preview).toBeNull()
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
    // A background slice after the edit refuses the same way, without a toast.
    set({ toast: null } as never)
    await slicePlate(e.host, { auto: true })
    expect(get().slice).toMatchObject({ status: 'error', code: 'resume_void' })
    expect(get().toast).toBeNull()
    expect(e.requests).toHaveLength(1)
  })

  it('refuses a slice that lands after an edit made while it ran', async () => {
    const e = engine()
    plan()
    const go = e.holdSlices()
    const p = slicePlate(e.host)
    await vi.waitFor(() => expect(e.requests).toHaveLength(1))
    edit()
    go()
    await p
    expect(get().slice).toMatchObject({ status: 'error', message: RESUME_VOID, code: 'resume_void' })
    expect(printBlock(get())).toBe(RESUME_VOID)
  })

  it('refuses a plan for this plate that does not say what it was made from', async () => {
    const e = engine()
    set({ resume: { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, plate: 'plate-1' } })
    await slicePlate(e.host)
    expect(e.requests).toHaveLength(0)
    expect(get().slice).toMatchObject({ code: 'resume_void' })
  })

  it("refuses mimir's slice, so printer.queue keeps no slice of the plate to send", async () => {
    const e = engine()
    plan()
    edit()
    const [slice] = mimirCommands(e.host, [{ id: 'slice', title: 'Slice', section: 'slice', run: () => undefined }])
    const cx = { sliced: vi.fn(), refused: vi.fn() }
    const out = await (slice!.run as (i: unknown, cx: unknown) => Promise<unknown>)(undefined, cx)
    expect(out).toEqual({ status: 'error', message: RESUME_VOID })
    expect(cx.refused).toHaveBeenCalledWith(1)
    expect(cx.sliced).not.toHaveBeenCalled()
    expect(e.requests).toHaveLength(0)
    // Cleared: mimir's slice lands and printer.queue gets it.
    printEverythingAgain()
    expect(await (slice!.run as (i: unknown, cx: unknown) => Promise<unknown>)(undefined, cx)).toMatchObject({ status: 'done' })
    expect(cx.sliced).toHaveBeenCalledTimes(1)
  })
})

describe('a plan kept for another plate', () => {
  it('holds nothing on plate 2: it slices whole, prints and exports, with a note that names plate 1', async () => {
    const e = engine()
    plan()
    toPlate2()
    expect(resumeVoid(get())).toBeNull()
    expect(resumeElsewhere(get())).toBe(1)
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done' })
    expect(e.requests.at(-1)!.options).not.toHaveProperty('resumeFromLayer')
    expect(e.requests.at(-1)!.plate.objects.map((o) => o.id)).toEqual(['b'])
    expect(printBlock(get())).toBeNull()
    await exportGcode(e.host)
    expect(e.exported).toHaveLength(1)
    const sent = sendToPrinter(e.host, BAY)
    await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
    act(() => get().printSheet!.resolve(null))
    await sent
    render(wrap(e.host, createElement(SliceBlock)))
    expect(screen.getByTestId('resume-elsewhere').textContent).toBe('A resume plan is kept for plate 1. This plate prints in full.')
    expect(screen.queryByTestId('resume-plan-again')).toBeNull()
    // An edit on plate 2 leaves plate 1's plan as it was.
    edit()
    toPlate1()
    expect(activeResume(get())).toBeNull()
    set({ overrides: {} })
    expect(activeResume(get())).not.toBeNull()
  })

  it('holds on plate 1 again after a switch to plate 2 and back', async () => {
    const e = engine()
    plan()
    toPlate2()
    await slicePlate(e.host)
    toPlate1()
    expect(resumeElsewhere(get())).toBeNull()
    expect(activeResume(get())).not.toBeNull()
    await slicePlate(e.host)
    expect(e.requests.at(-1)!.options).toMatchObject({ resumeFromLayer: 2 })
    await exportGcode(e.host)
    expect(e.exported).toHaveLength(1)
  })
})

describe('Export every plate with a resume plan kept', () => {
  it('refuses up front, naming the plan, and its command and menu item say so', async () => {
    const e = engine()
    plan()
    expect(exportAllBlock(get())).toBe('A resume plan is kept for plate 1. Print that plate on its own, or choose Print everything again first.')
    expect(await exportAllPlates(e.host)).toBe(false)
    expect(e.requests).toHaveLength(0)
    expect(e.saved).toEqual([])
    expect(get().toast).toMatchObject({ text: exportAllBlock(get()), tone: 'error' })
    expect(get().activePlate).toBe('plate-1')
    // The same while plate 2 shows, and with the plan voided.
    toPlate2()
    expect(await exportAllPlates(e.host)).toBe(false)
    toPlate1()
    edit()
    expect(await exportAllPlates(e.host)).toBe(false)
    expect(e.requests).toHaveLength(0)
    // Cleared: every plate slices into one file.
    printEverythingAgain()
    expect(exportAllBlock(get())).toBeNull()
    expect(await exportAllPlates(e.host)).toBe(true)
    expect(e.requests).toHaveLength(2)
    expect(e.saved).toHaveLength(1)
  })
})

describe('the two ways on from a plan that no longer matches', () => {
  it("are in the Prepare footer once, beside the refusal, and each works", async () => {
    const e = engine()
    plan()
    edit()
    await slicePlate(e.host)
    render(createElement(() => {
      const ask = useResumeAsk()
      return createElement('div', null, wrap(e.host, createElement(SliceBlock)), createElement('output', { 'data-testid': 'ask' }, ask ? 'open' : 'closed'))
    }))
    // The refusal says it once: the slice error does not repeat the block above it.
    expect(document.body.textContent!.split(RESUME_VOID)).toHaveLength(2)
    expect(screen.queryByTestId('slice-estimate-error')).toBeNull()
    fireEvent.click(screen.getByTestId('resume-plan-again'))
    expect(screen.getByTestId('ask').textContent).toBe('open')
    act(() => closeResume())
    fireEvent.click(screen.getByTestId('resume-print-everything'))
    expect(get().resume).toBeNull()
    expect(screen.queryByTestId('resume-plan-again')).toBeNull()
  })

  it('are in Preview, where Export waits', async () => {
    const e = engine()
    plan()
    await slicePlate(e.host)
    render(wrap(e.host, createElement(PreviewRight)))
    const exportButton = () => screen.getByRole('button', { name: /Export G-code/ }) as HTMLButtonElement
    expect(exportButton().disabled).toBe(false)
    act(() => edit())
    expect(exportButton().disabled).toBe(true)
    expect(screen.getByTestId('resume-plan-again')).toBeTruthy()
    fireEvent.click(screen.getByTestId('resume-print-everything'))
    expect(get().resume).toBeNull()
    expect(screen.queryByTestId('resume-plan-again')).toBeNull()
  })

  it('include the Print everything again command, there only while a plan is kept', () => {
    render(wrap(engine().host, createElement(ResumeDialog)))
    const cmd = getCommand('print-everything')!
    expect(isEnabled(cmd)).toBe(false)
    plan()
    expect(isEnabled(cmd)).toBe(true)
    act(() => void cmd.run(undefined as never))
    expect(get().resume).toBeNull()
    expect(isEnabled(cmd)).toBe(false)
  })

  it("include the dialog's Print everything again link, which clears the plan and closes the dialog", async () => {
    plan()
    edit()
    render(createElement(() => {
      const ask = useResumeAsk()
      return createElement('div', null, wrap(engine().host, createElement(ResumeDialog)), createElement('output', { 'data-testid': 'ask' }, ask ? 'open' : 'closed'))
    }))
    act(() => openResume())
    const kept = await screen.findByTestId('resume-kept')
    fireEvent.click(kept.querySelector('button')!)
    expect(get().resume).toBeNull()
    expect(screen.getByTestId('ask').textContent).toBe('closed')
  })
})

describe('a plan that holds, end to end', () => {
  it('slices the rest, exports it under the job name with no error, and reaches the Print sheet', async () => {
    const e = engine()
    plan()
    await slicePlate(e.host)
    expect(e.requests.at(-1)!.options).toMatchObject({ resumeFromLayer: 2 })
    set({ toast: null } as never)
    await exportGcode(e.host)
    expect(e.exported).toHaveLength(1)
    expect(e.saved).toHaveLength(1)
    expect(e.saved[0]).toMatch(/\.gcode$/)
    expect(get().toast).toMatchObject({ text: `Exported ${e.saved[0]}` })
    const sent = sendToPrinter(e.host, BAY)
    await vi.waitFor(() => expect(get().printSheet).not.toBeNull())
    act(() => get().printSheet!.resolve(null))
    await sent
    expect(printBlock(get())).toBeNull()
  })
})

describe("Preview's resume line", () => {
  it('shows for a plan that holds, and goes when the plate changes or another plate shows', async () => {
    plan()
    await slicePlate(engine().host)
    const preview = readPreview(rawPreview())
    set({ preview })
    render(createElement(HostContext.Provider, { value: engine().host }, createElement(EditionContext.Provider, { value: NEUTRAL }, createElement(PreviewLeft))))
    expect(document.querySelector('[data-resume]')?.textContent).toMatch(/Resumes at layer 3/)
    act(() => edit())
    expect(document.querySelector('[data-resume]')).toBeNull()
    act(() => set({ overrides: {} }))
    expect(document.querySelector('[data-resume]')).not.toBeNull()
    act(() => set({ activePlate: 'plate-2' }))
    expect(document.querySelector('[data-resume]')).toBeNull()
  })
})

describe("the resume dialog's banner", () => {
  it('says the plate prints from a layer only while the plan holds, and says a kept plan no longer matches', async () => {
    plan()
    edit()
    render(createElement(HostContext.Provider, { value: engine().host }, createElement(EditionContext.Provider, { value: NEUTRAL }, createElement(ResumeDialog))))
    act(() => openResume())
    await screen.findByTestId('resume-kept')
    expect(screen.queryByText(/set to print from layer/)).toBeNull()
    act(() => set({ overrides: {} }))
    await vi.waitFor(() => expect(screen.queryByText(/set to print from layer 3/)).not.toBeNull())
    expect(screen.queryByTestId('resume-kept')).toBeNull()
    expect(sliceInputsKey(get())).toBe(get().resume!.inputs)
  })

  it("on another plate, says which plate's plan a new one replaces", async () => {
    plan()
    toPlate2()
    render(wrap(engine().host, createElement(ResumeDialog)))
    act(() => openResume())
    expect((await screen.findByTestId('resume-elsewhere-dialog')).textContent).toMatch(/kept for plate 1\. A plan made here replaces it\./)
    expect(screen.queryByTestId('resume-kept')).toBeNull()
  })
})
