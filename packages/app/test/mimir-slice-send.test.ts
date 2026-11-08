// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The slice the chat's run records is the slice printer.queue sends, with the tab's real tools: app.slice keeps its
// slice where printer.queue reads it, so a slice from app.slice is sent as it is, and a slice the slice skill made
// before a plate change is never sent once app.slice has sliced the changed plate.
import type { ApprovalRequest, CommandSpec, Host, JobFile, MeshHandle, PilotEvent, PrinterHost, PrinterInfo, PrinterStatus, SliceResult } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG } from '@slicerx/pilot'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { sendLedger } from '../src/plate/send-ledger'
import { moveTower } from '../src/plate/tower'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { fingerprintInputs, plateFingerprint } from '../src/workspaces/mimir/print-run'
import { KEY_LEAVES_OUT, outputKey, plateInputsKey, sliceInputsKey } from '../src/plate/resume-tops'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

const result = (id: string): SliceResult =>
  ({ id, engine: 'native', layerCount: 50, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 1800, filamentMm: [1000], filamentG: [12], cost: 0.3, toolChanges: 0 }, stageMicros: {}, wallMs: 5, warnings: [] }) as unknown as SliceResult

// app.slice's slice: lands the next id on screen, as the Slice tab would, without the engine
const app = vi.hoisted(() => ({ next: 'app_1' }))
vi.mock('../src/state/actions', async (orig) => ({
  ...(await orig<typeof import('../src/state/actions')>()),
  // the run reads its fingerprint as the slice is stamped, as the real slicePlate calls onStamp
  slicePlate: async (_host: unknown, opts?: { onStamp?: (at: ReturnType<typeof get>) => void }) => {
    opts?.onStamp?.(get())
    set((st) => ({ slicesDone: st.slicesDone + 1, slice: { status: 'done', result: result(app.next), stale: false } }))
  },
}))

const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Bracket', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] }
const bracketAt = (x: number): PlateEntry => ({ id: 'a', name: 'Bracket', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [x, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

const info: PrinterInfo = { id: 'bench', name: 'Bench', vendor: 'Prusa', model: 'MK4', plugin: 'prusalink', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bench', state: 'idle', nozzles: [], slots: [{ id: '1', material: 'PLA', color: '#FFFFFF' }], cameraAvailable: false, updatedAt: '' }
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const SLICE: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => undefined }
const QUEUE = { name: 'printer.queue', args: { printerId: 'bench', plate: 1 } }

/** The tab's runtime with a slicer whose G-code names the slice it came from, and printers that keep what was uploaded. */
async function tab() {
  let skill = 0
  const uploaded: { name: string; text: string }[] = []
  const slicer = {
    loadModel: async () => handle,
    loadParts: async (name: string) => ({ ...handle, id: `h-${name}`, name }),
    // the slice skill's slices
    slice: async () => result(`skill_${++skill}`),
    exportGcode: async (id: string) => ({ fileName: `${id}.gcode`, blob: new Blob([`; slice ${id}\nG28\nG1 X10 Y10\n`]) }),
  }
  const printers = {
    list: async () => [info],
    plugins: async () => [],
    fleets: async () => [],
    status: async () => idle,
    subscribe: () => () => undefined,
    upload: async (printerId: string, file: JobFile) => {
      uploaded.push({ name: file.name, text: new TextDecoder().decode(file.data) })
      return { printerId, path: `/${file.name}`, name: file.name }
    },
    start: async () => undefined,
  } as unknown as PrinterHost
  const host = { kind: 'web', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [], commands: [SLICE] })
  return { options, uploaded }
}

/**
 * One scripted turn of `calls`. The send card is answered as a person would: the bed ticked and Print pressed, which
 * marks the ledger for the file the card shows, then approves the request.
 */
async function turn(options: Awaited<ReturnType<typeof tab>>['options'], calls: { name: string; args: Record<string, unknown> }[], pilotOf?: ReturnType<typeof createPilot>) {
  const pilot = pilotOf ?? createPilot({ ...options, client: createScriptedClient([...calls.map((c) => ({ calls: [c] })), { text: 'Done.' }], { chunk: false }) })
  const cards: ApprovalRequest[] = []
  const results: Extract<PilotEvent, { type: 'tool_result' }>[] = []
  for await (const ev of pilot.run('tab', 'go', {})) {
    if (ev.type === 'tool_result') results.push(ev)
    if (ev.type !== 'approval_request') continue
    cards.push(ev.request)
    const send = pilot.printRun?.('tab')?.send
    if (ev.request.tool === 'printer.queue' && send) sendLedger.mark(ev.request.id, send.printerId, send.sha256, ev.request.expiresAt)
    await pilot.resolveApproval(ev.request.id, { kind: 'approve', bedClear: true })
  }
  return { pilot, cards, results }
}

beforeEach(() => {
  app.next = 'app_1'
  set({ plate: [bracketAt(60)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', overrides: {}, objectSettings: {}, printerId: null, printerSlots: [], slice: { status: 'idle' }, approval: null, layerMarks: {}, profile: null } as never)
})

describe('printer.queue sends the slice the run records', () => {
  it('app.slice, then printer.queue, sends that slice', async () => {
    const { options, uploaded } = await tab()
    const { pilot, cards, results } = await turn(options, [{ name: 'app.slice', args: {} }, QUEUE])
    expect(pilot.printRun?.('tab')?.slice).toMatchObject({ sliceId: 'app_1', plate: 1, stale: false })
    expect(cards.map((c) => c.tool)).toEqual(['printer.queue'])
    expect(results.at(-1)).toMatchObject({ ok: true })
    expect(uploaded).toEqual([{ name: 'app_1.gcode', text: expect.stringContaining('; slice app_1') }])
    expect(pilot.printRun?.('tab')?.job).toMatchObject({ printerId: 'bench', fileName: 'app_1.gcode' })
  })

  it('a slice skill slice, a plate change and app.slice send the new G-code, never the old', async () => {
    const { options, uploaded } = await tab()
    const steps = [{ calls: [{ name: 'slice', args: {} }] }, { text: 'Sliced.' }, { calls: [{ name: 'app.slice', args: {} }] }, { calls: [QUEUE] }, { text: 'Sent.' }]
    const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
    await turn(options, [], pilot)
    expect(pilot.printRun?.('tab')?.slice).toMatchObject({ sliceId: 'skill_1', stale: false })
    // "move it over a bit": the plate changes after that slice
    set({ plate: [bracketAt(90)] })
    expect(pilot.printRun?.('tab')?.slice?.stale).toBe(true)
    app.next = 'app_2'
    const { results } = await turn(options, [], pilot)
    expect(pilot.printRun?.('tab')?.slice).toMatchObject({ sliceId: 'app_2', stale: false })
    expect(results.at(-1)).toMatchObject({ ok: true })
    expect(uploaded.map((u) => u.name)).toEqual(['app_2.gcode'])
    expect(uploaded[0]!.text).toContain('; slice app_2')
    expect(uploaded.some((u) => u.text.includes('skill_1'))).toBe(false)
  })
})

describe('printer.queue refuses a slice whose G-code an edit since has changed', () => {
  const PROFILE = { printerId: 'bench', nozzle: 0.4, nozzles: [0.4], nozzleFrom: 'printer', tier: 'standard', source: 'slicerx', shippedGcode: true, gcodeKeys: [], limits: {} }
  const SLOTS = [{ id: '1', material: 'PLA', color: '#FFFFFF', remainingG: 900 }]

  /** app.slice, then `edit`, then printer.queue in a later turn: what the run, the queue and the printer got. */
  async function sliceEditQueue(edit: (() => void) | { name: string; args: Record<string, unknown> }) {
    set({ profile: PROFILE, printerSlots: SLOTS } as never)
    const { options, uploaded } = await tab()
    // one chat: a turn that slices, then a turn that (makes the edit and) queues
    const call = typeof edit === 'function' ? [] : [{ calls: [edit] }]
    const steps = [{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Sliced.' }, ...call, { calls: [QUEUE] }, { text: 'Done.' }]
    const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
    await turn(options, [], pilot)
    expect(pilot.printRun?.('tab')?.slice).toMatchObject({ sliceId: 'app_1', stale: false })
    if (typeof edit === 'function') edit()
    const stale = pilot.printRun?.('tab')?.slice?.stale
    const { cards, results } = await turn(options, [], pilot)
    return { stale: typeof edit === 'function' ? stale : pilot.printRun?.('tab')?.slice?.stale, cards: cards.filter((c) => c.tool === 'printer.queue'), result: results.at(-1), uploaded }
  }

  const refused = (r: Awaited<ReturnType<typeof sliceEditQueue>>) => {
    expect(r.stale).toBe(true)
    expect(r.cards).toEqual([])
    expect(r.result).toMatchObject({ ok: false })
    expect(JSON.stringify(r.result)).toMatch(/stale_slice|changed after/)
    expect(r.uploaded).toEqual([])
  }

  it('after a pause is added at a layer', async () => {
    refused(await sliceEditQueue(() => set({ layerMarks: { p1: [{ id: 'm1', z: 2, kind: 'pause' }] } } as never)))
  })

  it('after an object is renamed', async () => {
    refused(await sliceEditQueue(() => set({ plate: get().plate.map((e) => ({ ...e, name: 'Bracket v2' })) })))
  })

  it("after the profile's G-code is no longer the shipped text", async () => {
    refused(await sliceEditQueue(() => set({ profile: { ...PROFILE, shippedGcode: false } } as never)))
  })

  // Everything else the slice reads, which the fingerprint now takes from the app's slice key.
  const twoParts = () => {
    const a = bracketAt(60)
    const b: PlateEntry = { ...bracketAt(140), id: 'b', name: 'Clip', parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot: 2 }] }
    set({ plate: [a, b] })
  }
  const VOLUME = { id: 'v1', name: 'Blocker', role: 'support_blocker', handle: { ...handle, id: 'v1', hash: 'v1' }, part: { ...boxMesh(5, 5, 5), name: 'Blocker', slot: 1 }, local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }

  it('after two objects swap filaments (each a slot override), with the same slots in use', async () => {
    twoParts()
    refused(await sliceEditQueue(() => set({ plate: get().plate.map((e) => ({ ...e, slotOverrides: { Body: e.id === 'a' ? 2 : 1 } })) })))
  })

  it('after a support blocker is added to an object', async () => {
    refused(await sliceEditQueue(() => set({ plate: get().plate.map((e) => ({ ...e, volumes: [VOLUME] })) } as never)))
  })

  it('after support is painted on an object', async () => {
    refused(await sliceEditQueue(() => set({ plate: get().plate.map((e) => ({ ...e, paint: { 0: { support: { 3: 'enforce' } } } })) } as never)))
  })

  it("after a history step's parameter is edited (the object's mesh is made again)", async () => {
    refused(await sliceEditQueue(() => set({ plate: get().plate.map((e) => ({ ...e, handle: { ...e.handle, hash: 'm1-step-edited' } })) })))
  })

  it("after mimir's settings tool turns supports off", async () => {
    set({ easy: { ...get().easy, supports: 'auto' } } as never)
    const r = await sliceEditQueue({ name: 'settings.apply', args: { target: 'plate', changes: { enable_support: false } } })
    expect(get().easy.supports).toBe('off')
    refused(r)
  })

  it('after the prime tower is moved', async () => {
    refused(await sliceEditQueue(() => moveTower(30, 40)))
  })

  it('but not after an object set not to print is renamed', async () => {
    set({ plate: [bracketAt(60), { ...bracketAt(140), id: 'off', name: 'Spare', printable: false }] })
    const r = await sliceEditQueue(() => set({ plate: get().plate.map((e) => (e.id === 'off' ? { ...e, name: 'Spare 2' } : e)) }))
    expect(r.stale).toBe(false)
    expect(r.result).toMatchObject({ ok: true })
    expect(r.uploaded.map((u) => u.name)).toEqual(['app_1.gcode'])
  })

  it('but not after a spool reload that changes only the grams left or the tag: that slice still sends', async () => {
    const r = await sliceEditQueue(() => set({ printerSlots: [{ ...SLOTS[0]!, remainingG: 120, spoolUid: 'new-spool' }] } as never))
    expect(r.stale).toBe(false)
    expect(r.cards.map((c) => c.tool)).toEqual(['printer.queue'])
    expect(r.result).toMatchObject({ ok: true })
    expect(r.uploaded.map((u) => u.name)).toEqual(['app_1.gcode'])
  })

  it('nor after a note-only change to a color change mark (its slot is a note in the project)', async () => {
    set({ layerMarks: { p1: [{ id: 'c1', z: 2, kind: 'color_change', slot: 1 }] } } as never)
    const r = await sliceEditQueue(() => set({ layerMarks: { p1: [{ id: 'c1', z: 2, kind: 'color_change', slot: 2 }] } } as never))
    expect(r.stale).toBe(false)
    expect(r.result).toMatchObject({ ok: true })
  })
})

describe("a plate out of view keeps its own G-code inputs in its fingerprint", () => {
  it('a rename or a pause on plate 2 changes its fingerprint while plate 1 is shown, and leaves plate 1 as it was', () => {
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [{ ...bracketAt(60), id: 'b', name: 'Clip' }], settings: {} }], layerMarks: {}, profile: null } as never)
    const one = plateFingerprint(get(), 1)
    const two = plateFingerprint(get(), 2)
    set({ plates: get().plates.map((p) => (p.id === 'p2' ? { ...p, objects: p.objects.map((e) => ({ ...e, name: 'Clip v2' })) } : p)) })
    const renamed = plateFingerprint(get(), 2)
    expect(renamed).not.toBe(two)
    set({ layerMarks: { p2: [{ id: 'm1', z: 2, kind: 'pause' }] } } as never)
    expect(plateFingerprint(get(), 2)).not.toBe(renamed)
    expect(plateFingerprint(get(), 1)).toBe(one)
  })
})

describe("mimir's fingerprint reads the app's slice key", () => {
  it('takes the slice inputs key and the output key of the plate, so no slice input can be left out', () => {
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [{ ...bracketAt(60), id: 'b', name: 'Clip' }], settings: {} }] } as never)
    expect(fingerprintInputs(get(), 1)).toMatchObject({ inputs: sliceInputsKey(get()), output: outputKey(get()) })
    expect(fingerprintInputs(get(), 2)).toMatchObject({ inputs: plateInputsKey(get(), 'p2') })
  })

  it('covers every slice input the key leaves out some other way', () => {
    // The key leaves these out; the fingerprint must still read each. A new one fails here until it is handled.
    const handled: Record<string, string> = { layerMarks: 'output', resume: 'resume', plates: 'inputs (the plate own settings)', plate: 'inputs (each object as the slice sees it)', calibration: 'inputs (the plate calibration)' }
    expect(Object.keys(KEY_LEAVES_OUT).sort()).toEqual(Object.keys(handled).sort())
    const fields = Object.keys(fingerprintInputs(get(), 1))
    for (const f of ['inputs', 'output', 'resume']) expect(fields).toContain(f)
  })
})

