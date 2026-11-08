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
import { get, set, type PlateEntry } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
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
async function tab(opts: { tower?: boolean } = {}) {
  let n = 0
  const uploaded: string[] = []
  const slicer = {
    loadModel: async (m: { id?: string }) => handle(m.id ?? 'm'),
    release: () => undefined,
    getPreview: async () => rawPreview(),
    slice: async () => ({ id: `r${++n}`, engine: 'sx', layerCount: 1, layerZ: Float32Array.from([0.2]), layerTimeS: Float32Array.from([1]), warnings: [], stats: { timeS: 60, filamentMm: [1, 1], filamentG: [1, 1], cost: 0, toolChanges: 1 }, stageMicros: {}, wallMs: 1, ...(opts.tower ? { primeTower: { x: 200, y: 200, width: 35, depth: 35 } } : {}) }) as unknown as SliceResult,
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
  return { options, uploaded }
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
    const r = await sliceThenQueue(options, () => set({ slotSetup: { 1: { type: 'PETG', brand: 'Generic', color: '#ff0000' } } } as never))
    // the profile layer was rebuilt for the new filament while the slice waited for it
    expect(get().profile).not.toBe(profileBefore)
    expect(r.sliced).toMatchObject({ sliceId: 'r1', stale: false })
    expect(r.cards).toHaveLength(1)
    expect(uploaded).toEqual(['r1.gcode'])
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
