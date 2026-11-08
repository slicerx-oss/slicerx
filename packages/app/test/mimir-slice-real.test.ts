// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir's slice with the app's real slice and the real profile layer: a slice made right after a filament change is
// current when it lands, printer.queue sends it, and a multi-color plate with an auto tower stays current after it.
import { SXPV_HEADER_BYTES, SXPV_MAGIC, SXPV_SEGMENT_BYTES, SXPV_VERSION, type ApprovalRequest, type CommandSpec, type Host, type JobFile, type MeshHandle, type PrinterHost, type PrinterInfo, type PrinterStatus, type SliceResult } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG } from '@slicerx/pilot'
import { beforeEach, describe, expect, it } from 'vitest'
import { boxMesh } from '../src/plate/mesh-ops'
import { sendLedger } from '../src/plate/send-ledger'
import { compose } from '../src/plate/transform'
import { profileReady } from '../src/state/profile-sync'
import { printerMinFlush } from '../src/filament/flush'
import { removePlate } from '../src/plate/plates'
import { printerBase } from '../src/workspaces/prepare/printer-base'
import { appStore, get, set, type PlateEntry } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { plateFingerprint } from '../src/workspaces/mimir/print-run'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

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

const handle = (id: string, slot = 1): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [20, 20, 10], openEdges: 0, parts: [{ name: 'Body', slot, triangles: 12 }] })
const part = (id: string, x: number, slot: number): PlateEntry => ({ id, name: id, handle: handle(id, slot), parts: [{ ...boxMesh(20, 20, 10), name: 'Body', slot }], colors: ['#fff'], transform: compose({ position: [x, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

const info: PrinterInfo = { id: 'bench', name: 'Bench', vendor: 'Prusa', model: 'MK4', plugin: 'prusalink', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bench', state: 'idle', nozzles: [], slots: [{ id: '1', material: 'PLA', color: '#FFFFFF' }], cameraAvailable: false, updatedAt: '' }
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }
const SLICE: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => undefined }
const QUEUE = { name: 'printer.queue', args: { printerId: 'bench', plate: 1 } }

/** The tab's runtime with an engine that slices at once (`primeTower` when asked) and printers that keep uploads. */
async function tab(opts: { tower?: boolean; during?: () => void } = {}) {
  let n = 0
  const uploaded: string[] = []
  const requests: { config: Record<string, unknown> }[] = []
  const slicer = {
    loadModel: async (m: { id?: string }) => handle(m.id ?? 'm'),
    release: () => undefined,
    getPreview: async () => rawPreview(),
    slice: async (req: { config: Record<string, unknown> }) => (requests.push(req), opts.during?.(), { id: `r${++n}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings: [], stats: { timeS: 60, filamentMm: [1, 1], filamentG: [1, 1], cost: 0, toolChanges: 1 }, stageMicros: {}, wallMs: 1, ...(opts.tower ? { primeTower: { x: 200, y: 200, width: 35, depth: 35 } } : {}) }) as unknown as SliceResult,
    exportGcode: async (id: string) => ({ fileName: `${id}.gcode`, bytes: 4, sha256: '', blob: new Blob([`; slice ${id}\nG28\n`]) }),
  }
  const printers = {
    list: async () => [info],
    plugins: async () => [],
    fleets: async () => [],
    status: async () => idle,
    subscribe: () => () => undefined,
    upload: async (printerId: string, file: JobFile) => (uploaded.push(file.name), { printerId, path: `/${file.name}`, name: file.name }),
    start: async () => undefined,
  } as unknown as PrinterHost
  const host = { kind: 'desktop', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [], commands: [SLICE] })
  return { options, uploaded, requests }
}

/** One chat: a turn of `before` then app.slice, then a turn that queues. Cards are answered as a person would. */
async function sliceThenQueue(options: Awaited<ReturnType<typeof tab>>['options'], edit: () => void) {
  const steps = [{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Sliced.' }, { calls: [QUEUE] }, { text: 'Done.' }]
  const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
  const cards: ApprovalRequest[] = []
  const run = async () => {
    for await (const ev of pilot.run('tab', 'go', {})) {
      if (ev.type !== 'approval_request') continue
      cards.push(ev.request)
      const send = pilot.printRun?.('tab')?.send
      if (ev.request.tool === 'printer.queue' && send) sendLedger.mark(ev.request.id, send.printerId, send.sha256, ev.request.expiresAt)
      await pilot.resolveApproval(ev.request.id, { kind: 'approve', bedClear: true })
    }
  }
  // the edit lands just before the slice turn, so the profile layer is still rebuilding as the slice starts
  edit()
  await run()
  const sliced = pilot.printRun?.('tab')?.slice
  await run()
  return { sliced, cards: cards.filter((c) => c.tool === 'printer.queue') }
}

beforeEach(async () => {
  set({ printerModel: { id: 'bench', vendor: 'Prusa', model: 'MK4' }, printerId: 'bench', printerSlots: [], slotSetup: {}, layerMarks: {}, overrides: {}, objectSettings: {}, slice: { status: 'idle' }, approval: null, autoSlice: false, tower: { auto: true, x: 0, y: 0 }, towerFromProject: false, projectTowers: {} } as never)
  set({ plate: [part('a', 60, 1)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1' })
  await profileReady()
})

describe("mimir's real slice is current when it lands", () => {
  it('a filament change just before the slice: the slice is current and printer.queue sends it', async () => {
    const { options, uploaded } = await tab()
    const profileBefore = get().profile
    let early = ''
    const r = await sliceThenQueue(options, () => {
      set({ slotSetup: { 1: { type: 'PETG', brand: 'Generic', color: '#ff0000' } } } as never)
      // the fingerprint a read before the profile rebuilt would take
      early = plateFingerprint(get(), 1)
    })
    // the profile layer was rebuilt for the new filament while the slice waited for it, and the slice records the plate
    // as it was once rebuilt
    expect(get().profile).not.toBe(profileBefore)
    expect(r.sliced?.fingerprint).not.toBe(early)
    expect(r.sliced).toMatchObject({ sliceId: 'r1', stale: false })
    expect(r.cards).toHaveLength(1)
    expect(uploaded).toEqual(['r1.gcode'])
  })

  it('plate 1 deleted while plate 2 waits for its profile: the slice is recorded as the plate it is, and an edit to it reads stale', async () => {
    // three plates, the second shown
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [part('x', 60, 1)], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [], settings: {} }, { id: 'p3', name: 'Plate 3', objects: [part('z', 60, 1)], settings: {} }], activePlate: 'p2', plate: [part('a', 60, 1)] })
    const { options } = await tab()
    const steps = [{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Sliced.' }]
    const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
    // when the rebuilt profile lands (the slice is waiting for it), plate 1 is deleted: plate 2 becomes plate 1
    let deleted = false
    const off = appStore.subscribe((st, prev) => {
      if (!deleted && st.profile !== prev.profile && st.slice.status !== 'running') deleted = removePlate('p1')
    })
    set({ slotSetup: { 1: { type: 'PETG', brand: 'Generic', color: '#ff0000' } } } as never)
    for await (const ev of pilot.run('tab', 'go', {})) if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    off()
    expect(deleted).toBe(true)
    expect(get().plates.map((p) => p.id)).toEqual(['p2', 'p3'])
    expect(pilot.printRun?.('tab')?.slice).toMatchObject({ sliceId: 'r1', plate: 1, stale: false })
    // the shown plate (once plate 2) changes: its slice reads stale, so printer.queue would refuse it
    set({ plate: get().plate.map((e) => ({ ...e, transform: compose({ position: [90, 100, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) })) })
    expect(pilot.printRun?.('tab')?.slice?.stale).toBe(true)
  })

  it('plate 1 deleted while the engine slices plate 2: nothing is recorded, the reply says stale and printer.queue has nothing to send', async () => {
    set({ plates: [{ id: 'p1', name: 'Plate 1', objects: [part('x', 60, 1)], settings: {} }, { id: 'p2', name: 'Plate 2', objects: [], settings: {} }, { id: 'p3', name: 'Plate 3', objects: [part('z', 60, 1)], settings: {} }], activePlate: 'p2', plate: [part('a', 60, 1)] })
    await profileReady()
    // while the engine slices (after the stamp): plate 2 becomes plate 1, and number 2 now names plate 3
    let deleted = false
    const { options, uploaded } = await tab({ during: () => void (!deleted && get().slice.status === 'running' && (deleted = removePlate('p1'))) })
    const steps = [{ calls: [{ name: 'app.slice', args: {} }] }, { calls: [{ name: 'printer.queue', args: { printerId: 'bench', plate: 2 } }] }, { text: 'Done.' }]
    const pilot = createPilot({ ...options, client: createScriptedClient(steps, { chunk: false }) })
    // a chat of its own, so no slice an earlier test recorded is in it
    const results: unknown[] = []
    for await (const ev of pilot.run('engine-delete', 'go', {})) {
      if (ev.type === 'tool_result') results.push(ev)
      if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve', bedClear: true })
    }
    expect(deleted).toBe(true)
    expect(get().plates.map((p) => p.id)).toEqual(['p2', 'p3'])
    expect(JSON.stringify(results[0])).toMatch(/"status":"stale"/)
    expect(pilot.printRun?.('engine-delete')?.slice).toBeFalsy()
    // no slice was kept for plate 2 (now plate 3), so none goes to the printer
    expect(results[1]).toMatchObject({ ok: false })
    expect(uploaded).toEqual([])
  })

  it("a printer change just before the slice of a two-color plate: the slice stays current once Prepare sets the printer's nozzle volume", async () => {
    const H2D = { id: 'h2d', vendor: 'Bambu Lab', model: 'H2D' }
    const P1S = { id: 'p1s', vendor: 'Bambu Lab', model: 'P1S' }
    const volume = (m: { vendor: string; model: string }) => printerMinFlush((printerBase(m) as unknown as Record<string, never>)['nozzle_volume'])
    set({ printerModel: H2D, plate: [part('a', 60, 1), part('b', 120, 2)], slotSetup: { 1: { type: 'PLA', brand: 'Generic', color: '#ffffff' }, 2: { type: 'PLA', brand: 'Generic', color: '#000000' } } } as never)
    await profileReady()
    set({ printerNozzleVolume: volume(H2D) })
    // the two printers' nozzle volumes differ, so the flush volumes in the G-code do
    expect(volume(P1S)).not.toBe(volume(H2D))
    // Prepare's printer panel sets the printer's nozzle volume a moment after the printer changes
    const timers: ReturnType<typeof setTimeout>[] = []
    const off = appStore.subscribe((st, prev) => {
      if (st.printerModel !== prev.printerModel && st.printerModel) timers.push(setTimeout(() => set({ printerNozzleVolume: volume(st.printerModel!) }), 30))
    })
    const { options } = await tab()
    const pilot = createPilot({ ...options, client: createScriptedClient([{ calls: [{ name: 'app.slice', args: {} }] }, { text: 'Sliced.' }], { chunk: false }) })
    set({ printerModel: P1S } as never)
    for await (const ev of pilot.run('printer-change', 'go', {})) if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    await new Promise((done) => setTimeout(done, 100))
    off()
    timers.forEach(clearTimeout)
    expect(get().printerNozzleVolume).toBe(volume(P1S))
    expect(pilot.printRun?.('printer-change')?.slice).toMatchObject({ sliceId: 'r1', stale: false })
  })

  it("the slice tool right after a part moves to another slot: it slices with the rebuilt profile, and the slice is current", async () => {
    const { options, requests } = await tab()
    const pilot = createPilot({ ...options, client: createScriptedClient([{ calls: [{ name: 'slice', args: {} }] }, { text: 'Sliced.' }], { chunk: false }) })
    const ids = get().profile?.filamentIds
    // the part moves to slot 2, as picking a spool in another slot does: the profile layer rebuilds for two filaments
    set({ plate: get().plate.map((e) => ({ ...e, slotOverrides: { Body: 2 } })) })
    for await (const ev of pilot.run('slot-move', 'go', {})) if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    await profileReady()
    expect(get().profile?.filamentIds).not.toEqual(ids)
    expect(requests).toHaveLength(1)
    // the configuration sliced lists both slots, from the rebuilt layer
    expect(requests[0]!.config['filament_flow_ratio']).toHaveLength(2)
    expect(pilot.printRun?.('slot-move')?.slice).toMatchObject({ sliceId: 'r1', stale: false })
  })

  it('a two-color plate with an auto tower: the slice is current after it lands and printer.queue sends it', async () => {
    set({ plate: [part('a', 60, 1), part('b', 120, 2)], slotSetup: { 1: { type: 'PLA', brand: 'Generic', color: '#ffffff' }, 2: { type: 'PLA', brand: 'Generic', color: '#000000' } } } as never)
    await profileReady()
    const { options, uploaded } = await tab({ tower: true })
    const r = await sliceThenQueue(options, () => undefined)
    expect(r.sliced).toMatchObject({ sliceId: 'r1', stale: false })
    expect(r.cards).toHaveLength(1)
    expect(uploaded).toEqual(['r1.gcode'])
  })
})
