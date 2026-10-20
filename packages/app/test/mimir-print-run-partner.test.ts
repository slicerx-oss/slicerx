// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A partner edition keeps the print run in the mimir tab, minus the tool groups it switches off. Without printers,
// mimir still slices and the slice stays for the person to save, but nothing picks a printer, reaches one or shows the
// send card, and the target, send and print steps read as off. Without design, mimir still picks the printer, slices
// the part already on the plate and sends it on the send card. The send card names the partner's assistant.
import type { ApprovalRequest, CommandSpec, Host, MeshHandle, PilotEvent, PrinterHost, PrinterInfo, PrinterStatus, SliceResult } from '@slicerx/contracts'
import { setAssistantBrand } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, runSteps, type PilotTool, type ToolGroups } from '@slicerx/pilot'
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NEUTRAL, currentEdition, setCurrentEdition } from '../src/edition'
import { HostContext } from '../src/host'
import { editionToolGroups } from '../src/pilot-connect/brain'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
import { get, set, type PlateEntry } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { RUN_APPROVAL_CARDS } from '../src/workspaces/mimir/run-cards'
import { SendCard } from '../src/workspaces/mimir/send-card'
import { tabPilotOptions } from '../src/workspaces/mimir/session'

// app.slice's slice: lands one on screen, as the Slice tab would, without the engine
vi.mock('../src/state/actions', async (orig) => ({
  ...(await orig<typeof import('../src/state/actions')>()),
  slicePlate: async () => {
    set((st) => ({ slicesDone: st.slicesDone + 1, slice: { status: 'done', result: result('s1'), stale: false } }))
  },
}))

const result = (id: string): SliceResult =>
  ({ id, engine: 'native', layerCount: 50, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 1800, filamentMm: [1000], filamentG: [12], cost: 0.3, toolChanges: 0 }, stageMicros: {}, wallMs: 5, warnings: [] }) as unknown as SliceResult

const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Bracket', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] }
const bracket: PlateEntry = { id: 'a', name: 'Bracket', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }

const info: PrinterInfo = { id: 'bench', name: 'Bench', vendor: 'Prusa', model: 'MK4', plugin: 'prusalink', nozzleCount: 1 }
const idle: PrinterStatus = { printerId: 'bench', state: 'idle', nozzles: [], slots: [{ id: '1', material: 'PLA', color: '#FFFFFF' }], cameraAvailable: false, updatedAt: '' }
const printers = { list: async () => [info], plugins: async () => [], fleets: async () => [], status: async () => idle, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

const tool = (name: string) => defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: name, input: z.object({}), run: async () => ({ summary: 'ok' }) }) as PilotTool<never>
const DESIGN_TOOLS = [tool('design.new'), tool('geom.info')]
const SLICE: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => undefined }

const partner = (tools: Partial<Record<'design' | 'printers', boolean>>) => ({ ...NEUTRAL, ai: { ...NEUTRAL.ai, brain: { ...NEUTRAL.ai.brain, tools } } })

type Call = { name: string; args: Record<string, unknown> }

/**
 * The tab's runtime as session.ts makes it for the edition, on a scripted turn of `calls`, one step each. A send card
 * is looked at and then answered Not now, so nothing is sent.
 */
async function turn(groups: ToolGroups, calls: Call[], onSend?: (request: ApprovalRequest, builtin: boolean | undefined, pilot: ReturnType<typeof createPilot>) => void) {
  const slicer = {
    loadModel: async () => handle,
    loadParts: async (name: string) => ({ ...handle, id: `h-${name}`, name }),
    slice: async () => result('s1'),
    exportGcode: async () => ({ fileName: 'bracket.gcode', blob: new Blob(['G28\nG1 X10 Y10\n']) }),
  }
  const host = { kind: 'web', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: DESIGN_TOOLS, commands: [SLICE], toolGroups: groups })
  const pilot = createPilot({ ...options, client: createScriptedClient([...calls.map((c) => ({ calls: [c] })), { text: 'Done.' }], { chunk: false }) })
  const events: PilotEvent[] = []
  for await (const ev of pilot.run('tab', 'go', {})) {
    events.push(ev)
    if (ev.type !== 'approval_request') continue
    if (ev.request.tool === 'printer.queue') onSend?.(ev.request, ev.builtin, pilot)
    await pilot.resolveApproval(ev.request.id, ev.request.tool === 'printer.queue' ? { kind: 'deny', reason: 'canceled' } : { kind: 'approve' })
  }
  const tools = new Map(events.flatMap((e) => (e.type === 'tool_call' ? [[e.callId, e.tool] as const] : [])))
  const results = new Map(events.flatMap((e) => (e.type === 'tool_result' ? [[tools.get(e.callId), e] as const] : [])))
  const asked = events.flatMap((e) => (e.type === 'approval_request' ? [e.request.tool] : []))
  return { pilot, results, asked, offered: pilot.tools().map((t) => t.name) }
}

const stateOf = (steps: ReturnType<typeof runSteps>) => Object.fromEntries(steps.map((s) => [s.name, s.state]))

const ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 4h14"/></svg>')}`
const before = currentEdition()

beforeEach(() => {
  set({ plate: [bracket], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: {} }], activePlate: 'p1', overrides: {}, objectSettings: {}, printerId: null, printerSlots: [], slice: { status: 'idle' }, approval: null })
})

afterEach(() => {
  cleanup()
  setCurrentEdition(before)
  setAssistantBrand()
})

describe('a partner edition keeps the print run', () => {
  it('a partner without printers slices and saves', async () => {
    const groups = editionToolGroups(partner({ printers: false }))
    expect(groups).toEqual({ printers: false })
    const { pilot, results, asked, offered } = await turn(groups, [
      { name: 'app.slice', args: {} },
      { name: 'run.target', args: { printer: 'Bench' } },
      { name: 'printer.queue', args: { printerId: 'bench', plate: 1 } },
    ])
    // nothing that picks or reaches a printer is offered
    expect(offered).toContain('app.slice')
    expect(offered).not.toContain('run.target')
    expect(offered.filter((n) => n.startsWith('printer.') || n.startsWith('printer_'))).toEqual([])
    // the slice runs and stays on screen, where the person saves it
    expect(results.get('app.slice')).toMatchObject({ ok: true })
    expect(get().slice).toMatchObject({ status: 'done', stale: false })
    // a call for a printer tool reaches nothing and shows no card, so no send card either
    expect(results.get('run.target')).not.toMatchObject({ ok: true })
    expect(results.get('printer.queue')).not.toMatchObject({ ok: true })
    expect(asked).toEqual([])
    expect(get().printerId).toBeNull()
    const run = pilot.printRun?.('tab')!
    expect(run.slice).toMatchObject({ sliceId: 's1', stale: false })
    expect(run.printerId).toBeNull()
    expect(run.send).toBeNull()
    expect(stateOf(runSteps(run, groups))).toEqual({ design: 'done', plate: 'done', target: 'off', slice: 'done', send: 'off', print: 'off' })
  })

  it('a partner without design still targets, slices and sends a part already on the plate', async () => {
    const groups = editionToolGroups(partner({ design: false }))
    expect(groups).toEqual({ design: false })
    const sent: { request: ApprovalRequest; builtin: boolean | undefined; steps: Record<string, string> }[] = []
    const { pilot, results, asked, offered } = await turn(
      groups,
      [
        { name: 'run.target', args: { printer: 'Bench', filaments: [{ material: 'PLA' }] } },
        { name: 'app.slice', args: {} },
        { name: 'slice', args: {} },
        { name: 'printer.queue', args: { printerId: 'bench', plate: 1 } },
      ],
      (request, builtin, p) => sent.push({ request, builtin, steps: stateOf(runSteps(p.printRun?.('tab')!, groups)) }),
    )
    expect(offered).not.toContain('design.new')
    expect(offered).not.toContain('geom.info')
    expect(offered).toEqual(expect.arrayContaining(['run.target', 'app.slice', 'printer.queue']))
    // the printer the person named, on the spool of the material they named
    expect(results.get('run.target')).toMatchObject({ ok: true })
    expect(pilot.printRun?.('tab')).toMatchObject({ printerId: 'bench', slots: { 1: '1' } })
    expect(get().printerId).toBe('bench')
    expect(results.get('app.slice')).toMatchObject({ ok: true })
    expect(results.get('slice')).toMatchObject({ ok: true })
    // the send waits for the person on the send card: the runtime's own printer.queue, which the tab draws as it
    expect(asked).toEqual(['printer.queue'])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.builtin).toBe(true)
    expect(sent[0]!.request.printerId).toBe('bench')
    expect(RUN_APPROVAL_CARDS[sent[0]!.request.tool]).toBe(SendCard)
    // while the card waits, the run has the send and only the design step is off
    expect(sent[0]!.steps).toEqual({ design: 'off', plate: 'done', target: 'done', slice: 'done', send: 'done', print: 'now' })
    // Not now: nothing was sent
    expect(results.get('printer.queue')).not.toMatchObject({ ok: true })
  })

  it("the send card names the partner's assistant", async () => {
    setCurrentEdition({ ...NEUTRAL, brand: { ...NEUTRAL.brand, assistant: { name: 'yourmate', icon: ICON, accent: { light: '#006b65', dark: '#63e6d4' } } } })
    const request: ApprovalRequest = { id: 'apr_1', sessionId: 't', tool: 'printer.queue', permission: 'start', title: 'Send plate 1 to Bench?', lines: [], printerId: 'bench', paramsHash: 'h', actions: [], expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }
    const host = { printers } as unknown as Host
    render(createElement(HostContext.Provider, { value: host }, createElement(SendCard, { request, resolution: null, actionable: true, onApprove: async () => undefined, onCancel: async () => undefined, run: null })))
    const card = screen.getByTestId('mimir-send')
    // the agent bridge refuses the whole card, bed tick and Print included, for a partner's assistant too
    expect(card.hasAttribute('data-agent-refuse')).toBe(true)
    expect(card.contains(screen.getByTestId('mimir-send-bed'))).toBe(true)
    const title = card.getAttribute('aria-label') ?? ''
    expect(title).toContain('yourmate')
    const tip = card.querySelector('[data-tip-title]')
    expect(tip).not.toBeNull()
    expect(`${tip!.getAttribute('data-tip-title')} ${tip!.getAttribute('data-tip-body') ?? ''}`).toContain('yourmate')
    // the partner's name only, never the built-in one
    expect(`${title} ${tip!.getAttribute('data-tip-title')} ${tip!.getAttribute('data-tip-body') ?? ''}`).not.toMatch(/mimir/i)
  })
})
