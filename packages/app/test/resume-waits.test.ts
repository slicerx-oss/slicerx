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
import { RESUME_VOID, resumeFor, SLICE_NOT_CURRENT } from '../src/plate/resume-tops'
import { compose } from '../src/plate/transform'
import { EXPORT_SWITCHED, exportAllPlates, exportGcode3mf } from '../src/export/actions'
import { createPageBridge, installCapture, sliceSummary, type Capture } from '../src/agent-bridge'
import { platesState } from '../src/app-link/plate-state'
import { builtinCommands } from '../src/commands/builtin'
import { registerCommands } from '../src/commands/registry'
import { switchPlate } from '../src/plate/plates'
import { sendToPrinter, slicePlate, STALE_SLICE } from '../src/state/actions'
import { autoSlicePending, startAutoSlice } from '../src/state/auto-slice'
import { get, set, type PlateEntry } from '../src/state/store'
import { mimirCommands, STALE_REPLY, SWITCHED_REPLY } from '../src/workspaces/mimir/session'

/** Gates the test holds the profile load and the project G-code question on. */
const gates = vi.hoisted(() => ({ profile: null as Promise<void> | null, question: null as Promise<void> | null, asked: 0, calls: 0, only: 0, answer: 'profile' as string | null }))
vi.mock('../src/state/profile-sync', async (original) => ({
  ...(await original<object>()),
  // `only` gates just that call (1 based); 0 gates every call while `profile` is set.
  profileReady: () => {
    gates.calls++
    return (gates.only === 0 || gates.only === gates.calls) && gates.profile ? gates.profile : Promise.resolve()
  },
}))
vi.mock('../src/state/project-gcode', async (original) => ({
  ...(await original<object>()),
  askProjectGcode: async () => {
    gates.asked++
    if (gates.question) await gates.question
    return gates.answer
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

/** A host that slices at once (or on the `slice` gate), uploads and prepares on gates when given, and starts locally when `hub`. */
function engine(opts: { hub?: boolean; upload?: ReturnType<typeof gate>; prepare?: ReturnType<typeof gate>; slice?: ReturnType<typeof gate> } = {}) {
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
        if (opts.slice) {
          opts.slice.reached++
          await opts.slice.wait
        }
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
  gates.calls = 0
  gates.only = 0
  gates.answer = 'profile'
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
    expect(get().toast?.text).toBe(`Demo 1 has ${e.uploads[0]}, but it did not start: the slice changed while it uploaded. Don't start it from the printer. Slice the plate again, then print.`)
    expect(get().toast?.tone).toBe('error')
  })

  it('names the plan, not a reslice, when the plan goes void while it uploads', async () => {
    const g = gate()
    const e = engine({ upload: g })
    plan()
    await slicePlate(e.host)
    const sent = confirm(e.host, DEMO)
    await vi.waitFor(() => expect(g.reached).toBe(1))
    set({ overrides: { ...get().overrides, wall_loops: 7 } })
    g.open()
    await sent
    expect(e.started).toEqual([])
    expect(get().toast?.text).toBe(`Demo 1 has ${e.uploads[0]}, but it did not start: the resume plan no longer matches the plate. Don't start it from the printer. Plan it again, or choose Print everything again.`)
    expect(RESUME_VOID).toContain('no longer matches')
  })

  it('does not start when another plate shows or an object is renamed while it uploads', async () => {
    for (const change of [() => switchPlate('plate-2'), () => set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })]) {
      set({ plate: [box], plates: [{ id: 'plate-1', name: 'Plate 1', objects: [], settings: {} }, { id: 'plate-2', name: 'Plate 2', objects: [other], settings: {} }], activePlate: 'plate-1', slice: { status: 'idle' }, preview: null, toast: null } as never)
      const g = gate()
      const e = engine({ upload: g })
      await slicePlate(e.host)
      const sent = confirm(e.host, DEMO)
      await vi.waitFor(() => expect(g.reached).toBe(1))
      change()
      g.open()
      await sent
      expect(e.uploads).toHaveLength(1)
      expect(e.started).toEqual([])
      expect(get().toast?.text).toBe(`Demo 1 has ${e.uploads[0]}, but it did not start: the slice changed while it uploaded. Don't start it from the printer. Slice the plate again, then print.`)
    }
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
    expect(get().toast).toMatchObject({ text: 'Plate 1: another plate was shown while it sliced, so nothing was saved. Run Export every plate again.', tone: 'error' })
    expect(e.requests).toEqual([])
    expect(e.saved).toEqual([])
    // The plate the person showed stays shown.
    expect(get().activePlate).toBe('plate-2')
  })

  it('Export every plate saves nothing when another plate shows while the second plate waits, with the first already sliced', async () => {
    const e = engine()
    const g = gate()
    gates.profile = g.wait
    gates.only = 2
    const out = exportAllPlates(e.host)
    await vi.waitFor(() => expect(gates.calls).toBe(2))
    expect(e.requests).toHaveLength(1)
    expect(get().activePlate).toBe('plate-2')
    switchPlate('plate-1')
    g.open()
    expect(await out).toBe(false)
    expect(get().toast?.text).toBe('Plate 2: another plate was shown while it sliced, so nothing was saved. Run Export every plate again.')
    expect(e.requests).toHaveLength(1)
    expect(e.saved).toEqual([])
    expect(get().activePlate).toBe('plate-1')
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

describe("the bridge's slice and mimir's slice read one stale rule, and pin their plate", () => {
  let capture: Capture | null = null
  afterEach(() => {
    capture?.stop()
    capture = null
  })
  function bridgeWith(host: Host) {
    const off = registerCommands(builtinCommands(host, []).filter((c) => c.id === 'slice'))
    capture = installCapture(window)
    const bridge = createPageBridge(capture)
    bridge.attach({} as never)
    return { bridge, off }
  }

  it('slices again after a rename, where it handed back the old summary, and exports then', async () => {
    const e = engine()
    const { bridge, off } = bridgeWith(e.host)
    try {
      await slicePlate(e.host)
      await expect(bridge.handle('export_info', {})).resolves.toMatchObject({ id: 'r1' })
      set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
      await expect(bridge.handle('export_info', {})).rejects.toMatchObject({ code: 'refused', message: 'the plate changed after the last slice; slice it again, then export' })
      await bridge.handle('slice', { timeoutMs: 5000 })
      expect(e.requests).toHaveLength(2)
      await expect(bridge.handle('export_info', {})).resolves.toMatchObject({ id: 'r2' })
    } finally {
      off()
    }
  })

  it('answers not_ready, slicing nothing, when another plate shows while its slice waits on the profile', async () => {
    const e = engine()
    const { bridge, off } = bridgeWith(e.host)
    try {
      const g = gate()
      gates.profile = g.wait
      const out = bridge.handle('slice', { timeoutMs: 5000 })
      await vi.waitFor(() => expect(gates.calls).toBe(1))
      toPlate2()
      gates.profile = null
      g.open()
      await expect(out).rejects.toMatchObject({ code: 'not_ready', message: 'another plate was shown before Plate 1 finished slicing, so no slice was kept for it; show it and slice again' })
      expect(e.requests).toEqual([])
    } finally {
      off()
    }
  })

  it('answers at once with the stale summary when an edit lands while its slice runs and nothing slices again', async () => {
    const held = gate()
    const e = engine({ slice: held })
    set({ autoSlice: false })
    const { bridge, off } = bridgeWith(e.host)
    try {
      const out = bridge.handle('slice', { timeoutMs: 3000 })
      await vi.waitFor(() => expect(e.requests).toHaveLength(1))
      // Renamed while the engine runs: the slice lands for the old name, and with auto slice off nothing slices again.
      set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
      const started = Date.now()
      held.open()
      await expect(out).resolves.toMatchObject({ status: 'done', stale: true, id: 'r1' })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(e.requests).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('answers not_ready at once, naming why, when the Slice command ends with nothing sliced', async () => {
    const e = engine()
    set({ autoSlice: false, plate: get().plate.map((p) => ({ ...p, printable: false })) })
    const { bridge, off } = bridgeWith(e.host)
    try {
      const started = Date.now()
      await expect(bridge.handle('slice', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'not_ready', message: 'Plate 1 was not sliced: Every object on this plate is set not to print. Turn one on first.' })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(e.requests).toEqual([])
    } finally {
      off()
    }
  })

  it('answers not_ready with the reason, not the old summary, when a stale earlier slice is on screen and nothing slices', async () => {
    const e = engine()
    set({ autoSlice: false })
    const { bridge, off } = bridgeWith(e.host)
    try {
      await slicePlate(e.host)
      set({ plate: get().plate.map((p) => ({ ...p, printable: false })) })
      const started = Date.now()
      await expect(bridge.handle('slice', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'not_ready', message: 'Plate 1 was not sliced: Every object on this plate is set not to print. Turn one on first.' })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(e.requests).toHaveLength(1)
    } finally {
      off()
    }
  })

  it("answers not_ready with the command's own message when the Slice command fails late, with a stale earlier slice on screen", async () => {
    const e = engine()
    set({ autoSlice: false })
    const { bridge, off } = bridgeWith(e.host)
    try {
      await slicePlate(e.host)
      set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
      // The profile fails to load after the bridge's first look at the command.
      gates.profile = new Promise<void>((_, no) => setTimeout(() => no(new Error('The printer profile did not load.')), 300))
      gates.profile.catch(() => undefined)
      await expect(bridge.handle('slice', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'not_ready', message: 'The printer profile did not load.' })
      expect(e.requests).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('reports a slice an object rename has put out of date as stale, as the plates list does', async () => {
    const e = engine()
    set({ autoSlice: false })
    await slicePlate(e.host)
    expect(sliceSummary(get())).toMatchObject({ status: 'done', stale: false })
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })) })
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    expect(sliceSummary(get())).toMatchObject({ status: 'done', stale: true })
    expect(platesState().plates[0]!.slice).toBe('stale')
  })

  it('with force, slices again over a current slice and answers with the new one only once it lands', async () => {
    const held = gate()
    const e = engine({ slice: held })
    set({ autoSlice: false })
    const { bridge, off } = bridgeWith(e.host)
    try {
      const first = slicePlate(e.host)
      held.open()
      await first
      const second = gate()
      // The same host, its next slice held on a new gate.
      ;(e.host.slicer as { slice: (r: SliceRequest) => Promise<SliceResult> }).slice = ((orig) => async (r: SliceRequest) => {
        const out = await orig(r)
        await second.wait
        return out
      })((e.host.slicer as { slice: (r: SliceRequest) => Promise<SliceResult> }).slice)
      let done = false
      const out = bridge.handle('slice', { force: true, timeoutMs: 3000 }).then((v) => ((done = true), v))
      await vi.waitFor(() => expect(e.requests).toHaveLength(2))
      await new Promise((r) => setTimeout(r, 300))
      expect(done).toBe(false)
      second.open()
      await expect(out).resolves.toMatchObject({ status: 'done', stale: false, id: 'r2' })
    } finally {
      off()
    }
  })

  it('with force, answers not_ready with the reason when the Slice command slices nothing, never the current slice', async () => {
    const e = engine()
    set({ autoSlice: false })
    const { bridge, off } = bridgeWith(e.host)
    try {
      await slicePlate(e.host)
      set({ plate: get().plate.map((p) => ({ ...p, printable: false })) })
      await expect(bridge.handle('slice', { force: true, timeoutMs: 3000 })).rejects.toMatchObject({ code: 'not_ready', message: 'Plate 1 was not sliced: Every object on this plate is set not to print. Turn one on first.' })
      expect(e.requests).toHaveLength(1)
    } finally {
      off()
    }
  })

  it('answers a slice the engine refuses with its error summary, as the description says', async () => {
    const e = engine()
    set({ autoSlice: false })
    ;(e.host.slicer as { slice: unknown }).slice = async () => {
      throw new Error('Box is off the bed.')
    }
    const { bridge, off } = bridgeWith(e.host)
    try {
      await expect(bridge.handle('slice', { timeoutMs: 3000 })).resolves.toMatchObject({ status: 'error', message: expect.stringContaining('Box is off the bed.') })
    } finally {
      off()
    }
  })

  it('never hands back an error from before: one on screen, then a Slice with nothing to slice, answers not_ready', async () => {
    const e = engine()
    set({ autoSlice: false, slice: { status: 'error', message: 'old' }, plate: get().plate.map((p) => ({ ...p, printable: false })) } as never)
    const { bridge, off } = bridgeWith(e.host)
    try {
      await expect(bridge.handle('slice', { timeoutMs: 3000 })).rejects.toMatchObject({ code: 'not_ready', message: 'Plate 1 was not sliced: Every object on this plate is set not to print. Turn one on first.' })
    } finally {
      off()
    }
  })

  describe('with auto slice on', () => {
    let stop: (() => void) | null = null
    afterEach(() => {
      stop?.()
      stop = null
      set({ autoSlice: false } as never)
    })
    const autoOn = () => set({ autoSlice: true, autoSliceBySize: false, liveEdit: false, revealHold: false, exampleSeeding: false, plateLoading: false, sliceHeld: false } as never)

    it('waits for the slice auto slice has pending for an edit made while its own ran, past the grace', async () => {
      const held = gate()
      const e = engine({ slice: held })
      autoOn()
      // Auto slice starts its slice 1.5 s after the edit: longer than the bridge's grace after its own slice ends.
      stop = startAutoSlice(e.host, 1500)
      const { bridge, off } = bridgeWith(e.host)
      try {
        const out = bridge.handle('slice', { timeoutMs: 4000 })
        await vi.waitFor(() => expect(e.requests).toHaveLength(1))
        // A setting changes while it runs: auto slice cancels it and slices again after its pause.
        set({ overrides: { ...get().overrides, wall_loops: 4 } })
        held.open()
        await expect(out).resolves.toMatchObject({ status: 'done', stale: false, id: 'r2' })
        expect(e.requests).toHaveLength(2)
      } finally {
        off()
      }
    }, 8000)

    it('waits for an auto slice that has started but still waits on the profile, past the grace', async () => {
      const held = gate()
      const e = engine({ slice: held })
      autoOn()
      stop = startAutoSlice(e.host, 0)
      const { bridge, off } = bridgeWith(e.host)
      try {
        const out = bridge.handle('slice', { timeoutMs: 5000 })
        await vi.waitFor(() => expect(e.requests).toHaveLength(1))
        // Auto slice's own slice (the second profile wait) waits 1.6 s on the profile: longer than the grace.
        gates.only = 2
        gates.profile = new Promise<void>((r) => setTimeout(r, 1600))
        set({ overrides: { ...get().overrides, wall_loops: 4 } })
        held.open()
        await expect(out).resolves.toMatchObject({ status: 'done', stale: false, id: 'r2' })
        expect(e.requests).toHaveLength(2)
      } finally {
        off()
      }
    }, 9000)

    it("keeps waiting for auto slice's run while the slice it canceled is slow to unwind", async () => {
      const held = gate()
      const e = engine({ slice: held })
      autoOn()
      stop = startAutoSlice(e.host, 0)
      const { bridge, off } = bridgeWith(e.host)
      try {
        // The bridge's own slice, held in the engine.
        const out = bridge.handle('slice', { timeoutMs: 6000 })
        await vi.waitFor(() => expect(e.requests).toHaveLength(1))
        // Two edits: auto slice cancels the bridge's slice, and its run waits for the engine to stop it, never
        // starting beside it.
        set({ overrides: { ...get().overrides, wall_loops: 4 } })
        set({ overrides: { ...get().overrides, wall_loops: 5 } })
        await vi.waitFor(() => expect(autoSlicePending()).toBe(true))
        expect(e.requests).toHaveLength(1)
        // The engine lets go: the canceled slice unwinds, and auto slice's run then waits 1.6 s on the profile (the
        // second profile wait), past the grace.
        gates.only = 2
        gates.profile = new Promise<void>((r) => setTimeout(r, 1600))
        held.open()
        await expect(out).resolves.toMatchObject({ status: 'done', stale: false, id: 'r2' })
        expect(gates.calls).toBe(2)
        expect(e.requests).toHaveLength(2)
        expect(autoSlicePending()).toBe(false)
      } finally {
        off()
      }
    }, 10000)

    it('answers after the grace when auto slice holds the slice for an edit still going (a drag)', async () => {
      const held = gate()
      const e = engine({ slice: held })
      autoOn()
      stop = startAutoSlice(e.host, 0)
      const { bridge, off } = bridgeWith(e.host)
      try {
        const out = bridge.handle('slice', { timeoutMs: 4000 })
        await vi.waitFor(() => expect(e.requests).toHaveLength(1))
        // A drag edits the plate: auto slice cancels the slice and waits for the release, which does not come here.
        set({ liveEdit: true, overrides: { ...get().overrides, wall_loops: 4 } } as never)
        held.open()
        const started = Date.now()
        await expect(out).rejects.toMatchObject({ code: 'not_ready', message: 'Plate 1 was not sliced' })
        expect(Date.now() - started).toBeGreaterThan(800)
        expect(e.requests).toHaveLength(1)
      } finally {
        off()
        set({ liveEdit: false } as never)
      }
    })
  })

  it("mimir's slice reads a rename since the last slice as stale when no new slice ran", async () => {
    const e = engine()
    await slicePlate(e.host)
    set({ plate: get().plate.map((p) => ({ ...p, name: 'Renamed' })), projectGcode: { source: 'Project.3mf', changes: [], asking: false } } as never)
    // The project G-code question is dismissed, so no slice runs.
    gates.answer = null
    const cx = { sliced: vi.fn(), refused: vi.fn() }
    expect(await runSlice(e.host, cx)).toEqual({ status: 'stale', message: STALE_REPLY })
    expect(e.requests).toHaveLength(1)
    expect(cx.sliced).not.toHaveBeenCalled()
  })
})
