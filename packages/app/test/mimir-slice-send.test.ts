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
import { compose } from '../src/plate/transform'
import { set, type PlateEntry } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

const result = (id: string): SliceResult =>
  ({ id, engine: 'native', layerCount: 50, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 1800, filamentMm: [1000], filamentG: [12], cost: 0.3, toolChanges: 0 }, stageMicros: {}, wallMs: 5, warnings: [] }) as unknown as SliceResult

// app.slice's slice: lands the next id on screen, as the Slice tab would, without the engine
const app = vi.hoisted(() => ({ next: 'app_1' }))
vi.mock('../src/state/actions', async (orig) => ({
  ...(await orig<typeof import('../src/state/actions')>()),
  slicePlate: async () => {
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
  set({ plate: [bracketAt(60)], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', overrides: {}, objectSettings: {}, printerId: null, printerSlots: [], slice: { status: 'idle' }, approval: null })
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
