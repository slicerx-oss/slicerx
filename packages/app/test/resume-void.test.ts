// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A resume plan that no longer matches the shown plate (another plate shown, or this one changed since) holds for none
// of it, and the plate must not quietly print whole into the part on the bed: Print and Export wait with one message
// until the plan is made again or cleared (Print everything again). The slice says so in its warnings, Preview's
// "Resumes at" line and the dialog's banner follow the same rule, and a spool reload or a rename keeps the plan.
import { act, cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readPreview, SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type Host, type SliceRequest, type SliceResult } from '@slicerx/contracts'
import { EditionContext, NEUTRAL } from '../src/edition'
import { exportGcode3mf } from '../src/export/actions'
import { HostContext } from '../src/host'
import { printBlock } from '../src/plate/heimdall'
import { boxMesh } from '../src/plate/mesh-ops'
import { ResumeDialog } from '../src/plate/resume-dialog'
import { closeResume, openResume } from '../src/plate/resume-state'
import { activeResume, printEverythingAgain, RESUME_VOID, resumeFor, sliceInputsKey } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { exportGcode, sendToPrinter, slicePlate } from '../src/state/actions'
import { STALE_RESUME } from '../src/state/slice-plate'
import { get, set, type PlateEntry } from '../src/state/store'
import { PreviewLeft } from '../src/workspaces/preview/preview-panes'

HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open')
}

const part = { ...boxMesh(10, 10, 1), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 1], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }

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

/** A host whose slices land with `warnings`, and whose G-code export is counted. */
function engine(warnings: SliceResult['warnings'] = []) {
  const requests: SliceRequest[] = []
  const exported: string[] = []
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
        return { id: `r${requests.length}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings, stats: { timeS: 1, filamentMm: [1], filamentG: [1], cost: 0, toolChanges: 0 }, stageMicros: {}, wallMs: 1 } as unknown as SliceResult
      },
    },
    files: { save: async () => undefined },
    printers: {},
    approvals: {},
  } as unknown as Host
  return { host, requests, exported }
}

/** Stores a plan for the shown plate as it is, as Slice the rest does. */
const plan = () => set({ resume: resumeFor(get(), { plan: { resumeLayer: 2, printedHeightMm: 0.4 }, layerTopsMm: [0.2, 0.3, 0.4, 0.5, 0.6] }) })
const edit = () => set({ overrides: { ...get().overrides, wall_loops: Number(get().overrides['wall_loops'] ?? 2) + 1 } })

beforeEach(() => {
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, preview: null, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: {}, printerSlots: [], historyEdit: null, toast: null } as never)
})
afterEach(() => {
  act(() => closeResume())
  cleanup()
})

describe('Print and Export with a resume plan that no longer matches', () => {
  it('wait with one message after an edit or a switch, and go again once the plan is made again or cleared', async () => {
    const e = engine()
    plan()
    expect(printBlock(get())).toBeNull()
    edit()
    expect(printBlock(get())).toBe(RESUME_VOID)
    // Export G-code: the slice is current, but nothing leaves.
    await slicePlate(e.host)
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    await exportGcode(e.host)
    expect(e.exported).toEqual([])
    expect(get().toast).toMatchObject({ text: RESUME_VOID, tone: 'error' })
    // Export plate 3MF and Print on a printer wait the same way.
    expect(await exportGcode3mf(e.host)).toBe(false)
    set({ toast: null } as never)
    await sendToPrinter(e.host, { id: 'bay-1', name: 'Bay 1', vendor: 'Bambu Lab', model: 'A1', plugin: 'bambu', nozzleCount: 1 } as never)
    expect(get().toast).toMatchObject({ text: RESUME_VOID, tone: 'error' })
    expect(e.exported).toEqual([])
    // Planned again for the plate as it is now: Print and Export go.
    plan()
    expect(printBlock(get())).toBeNull()
    // Another plate shown: the plan is plate 1's, so they wait again.
    set({ activePlate: 'plate-2' })
    expect(printBlock(get())).toBe(RESUME_VOID)
    set({ activePlate: 'plate-1' })
    expect(printBlock(get())).toBeNull()
    // Cleared with Print everything again: they go, for the whole plate.
    edit()
    expect(printBlock(get())).toBe(RESUME_VOID)
    printEverythingAgain()
    expect(get().resume).toBeNull()
    expect(printBlock(get())).toBeNull()
    await slicePlate(e.host)
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

describe("the slice's note about a plan that no longer matches", () => {
  const notes = () => {
    const s = get().slice
    return s.status === 'done' ? s.result.warnings.map((w) => w.message) : []
  }

  it('is in the slice result once, and only while the plan does not hold', async () => {
    plan()
    await slicePlate(engine().host)
    expect(notes()).not.toContain(STALE_RESUME.message)
    edit()
    const e = engine()
    await slicePlate(e.host)
    expect(notes().filter((m) => m === STALE_RESUME.message)).toHaveLength(1)
    expect(e.requests[0]!.options).not.toHaveProperty('resumeFromLayer')
    // The engine already saying the same words does not repeat them.
    await slicePlate(engine([STALE_RESUME]).host)
    expect(notes().filter((m) => m === STALE_RESUME.message)).toHaveLength(1)
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
})
