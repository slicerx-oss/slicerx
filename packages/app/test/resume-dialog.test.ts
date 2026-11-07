// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The resume dialog with no current slice: it says once that it is working out the layers until the engine's land, plans
// in them, and Slice the rest stores exactly the layers the plan counted in, for this plate as it is. A slice landing
// in the background with the same layers changes nothing on screen, and an engine refusal shows in a slice's words.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Host, SliceRequest, SliceResult } from '@slicerx/contracts'
import { EditionContext, NEUTRAL } from '../src/edition'
import { setGeomProvider } from '../src/geom/client'
import { HostContext } from '../src/host'
import { engineErrorText } from '../src/lib/engine-errors'
import { boxMesh } from '../src/plate/mesh-ops'
import { ResumeDialog } from '../src/plate/resume-dialog'
import { closeResume, openResume } from '../src/plate/resume-state'
import { sliceInputsKey, sliceState } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'

// jsdom has no modal dialogs: open and close them as attributes.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open')
}

const WORKING = 'Working out the layers...'
const ENGINE = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]

const part = { ...boxMesh(10, 10, 1), name: 'Body', slot: 1 }
const box: PlateEntry = { id: 'a', name: 'Box', handle: { id: 'a', hash: 'a', name: 'a', triangles: 12, bboxMm: [10, 10, 1], openEdges: 0, parts: [{ name: 'Body', slot: 1, triangles: 12 }] }, parts: [part], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }

/** A host whose slices wait until `answer` (the engine's layers) or `fail`, recording each request. */
function heldHost() {
  const requests: { req: SliceRequest; local: boolean | undefined }[] = []
  const waiting: { res: (r: SliceResult) => void; rej: (e: Error) => void }[] = []
  const host = {
    kind: 'desktop',
    capabilities: { threads: 1 },
    slicer: {
      loadModel: async () => box.handle,
      release: () => undefined,
      slice: (req: SliceRequest, o?: { signal?: AbortSignal; local?: boolean }) => {
        requests.push({ req, local: o?.local })
        return new Promise<SliceResult>((res, rej) => {
          o?.signal?.addEventListener('abort', () => rej(new DOMException('Slice canceled', 'AbortError')))
          waiting.push({ res, rej })
        })
      },
    },
  } as unknown as Host
  return {
    host,
    requests,
    answer: () => waiting.shift()!.res({ id: 'r', layerZ: Float32Array.from(ENGINE), warnings: [] } as unknown as SliceResult),
    fail: (message: string) => waiting.shift()!.rej(new Error(message)),
  }
}

/** The geometry engine's resume plan, counting in the tops it is sent (the planner's rule), recording each request. */
const planned: { layerTopsMm?: number[] }[] = []
function fakePlanner(): void {
  setGeomProvider({
    call: async <T,>(_op: string, req: unknown) => {
      const r = req as { layerTopsMm?: number[]; measuredHeightMm: number }
      planned.push(r)
      const tops = r.layerTopsMm ?? []
      const at = tops.filter((t) => t <= r.measuredHeightMm + 0.05).length
      return { resumeLayer: at, resumeLayerNumber: at + 1, layerCount: tops.length, remainingLayers: tops.length - at, printedHeightMm: tops[at - 1] ?? 0, resumeZMm: tops[at] ?? 0, warnings: [] } as T
    },
  })
}

function mount(host: Host) {
  render(createElement(HostContext.Provider, { value: host }, createElement(EditionContext.Provider, { value: NEUTRAL }, createElement(ResumeDialog))))
  act(() => openResume())
}

/** Every time the working text appeared, as the DOM changed. */
function watchWorking(): { seen: () => number; stop: () => void } {
  let seen = 0
  const obs = new MutationObserver(() => {
    if (document.body.textContent?.includes(WORKING)) seen++
  })
  obs.observe(document.body, { subtree: true, childList: true, characterData: true })
  return { seen: () => seen, stop: () => obs.disconnect() }
}

const typeHeight = (mm: string) => fireEvent.change(document.getElementById('rs-height')!, { target: { value: mm } })

beforeEach(() => {
  planned.length = 0
  fakePlanner()
  set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'plate-1', resume: null, slice: { status: 'idle' }, calibration: {}, layerMarks: {}, objectSettings: {}, overrides: {}, projectSettings: null, historyEdit: null })
})
afterEach(() => {
  act(() => closeResume())
  cleanup()
})

describe('the resume dialog with no current slice', () => {
  it('says once that it is working out the layers, plans in the engine layers and stores exactly those', async () => {
    const h = heldHost()
    mount(h.host)
    // While the engine runs: the note shows once, in the plan's facts, and Slice the rest is off.
    expect(await screen.findAllByText(WORKING)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Slice the rest' })).toHaveProperty('disabled', true)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    expect(h.requests[0]!.local).toBe(true)
    expect(h.requests[0]!.req.options).toMatchObject({ emitGcode: false, emitPreview: false })
    await act(async () => h.answer())
    typeHeight('0.5')
    await screen.findByText(/nozzle at/)
    expect(screen.queryByText(WORKING)).toBeNull()
    expect(planned.at(-1)!.layerTopsMm).toEqual(Array.from(Float32Array.from(ENGINE)))
    // A stale slice in the store is not the job's: the plan stays on the engine's layers.
    act(() => set({ slice: { status: 'done', result: { id: 'old', layerZ: Float32Array.from([0.2, 0.4, 0.6, 0.8, 1]), warnings: [] } as unknown as SliceResult, stale: true } }))
    expect(screen.getByText(/nozzle at/)).toBeTruthy()
    const inputs = sliceInputsKey(sliceState(get()))
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Slice the rest' })))
    const stored = get().resume!
    expect(stored.layerTopsMm).toEqual(planned.at(-1)!.layerTopsMm)
    expect(stored.layerTopsMm).not.toEqual(Array.from(Float32Array.from([0.2, 0.4, 0.6, 0.8, 1])))
    expect(stored).toMatchObject({ plan: { resumeLayer: 4 }, plate: 'plate-1', inputs })
  })

  it('keeps the plan on screen when a slice with the same layers lands in the background', async () => {
    const h = heldHost()
    mount(h.host)
    await screen.findAllByText(WORKING)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    await act(async () => h.answer())
    typeHeight('0.5')
    await screen.findByText(/nozzle at/)
    const watch = watchWorking()
    const calls = planned.length
    await act(async () => {
      set({ slice: { status: 'done', result: { id: 'bg', layerZ: Float32Array.from(ENGINE), warnings: [] } as unknown as SliceResult, stale: false } })
      await new Promise((r) => setTimeout(r, 600))
    })
    watch.stop()
    expect(watch.seen()).toBe(0)
    expect(screen.getByText(/nozzle at/)).toBeTruthy()
    // Same layers: no new engine run and no new plan.
    expect(h.requests).toHaveLength(1)
    expect(planned.length).toBe(calls)
  })

  it("shows an engine refusal in a slice's words, and plans nothing", async () => {
    const h = heldHost()
    mount(h.host)
    await screen.findAllByText(WORKING)
    await vi.waitFor(() => expect(h.requests).toHaveLength(1))
    const raw = 'blocked by the safety preflight: the start G-code heats past the printer limit'
    await act(async () => h.fail(raw))
    expect((await screen.findByRole('alert')).textContent).toBe(engineErrorText(raw))
    expect(engineErrorText(raw)).not.toBe(raw)
    expect(screen.queryByText(WORKING)).toBeNull()
    expect(screen.getByRole('button', { name: 'Slice the rest' })).toHaveProperty('disabled', true)
  })
})
