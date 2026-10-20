// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's runtime on the open project, through the same options the tab makes it with: the project, the
// guides, settings, arrange and slicing (approvals stay with the person), New project behind the discard question, and
// a slice that keeps the tab on screen. A note mimir wants to keep asks first, with the memory chip, through the
// app's approvals.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, PilotEvent, PrinterHost, SliceRequest, SliceResult } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createRunBook, createScriptedClient, DEFAULT_CONFIG, runHandle, type CommandRun, type CommandToolContext } from '@slicerx/pilot'
import { appPrintRun } from '../src/workspaces/mimir/print-run'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { mimirCommands, tabPilotOptions } from '../src/workspaces/mimir/session'
import { scriptRouter } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'
import { MEMORY_CARDS } from '../src/workspaces/mimir/remember-chip'
import { NEUTRAL } from '../src/edition'
import { chatNotesGo, memoryFor, pilotMemory } from '../src/pilot-connect/memory'
import type { CommandSpec } from '@slicerx/contracts'
import { sourceOf } from '../src/plate/edit'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { placedOnBed } from '../src/plate/arrange'
import { bounds, compose, identity } from '../src/plate/transform'
import { setHostSlices } from '../src/state/model-mode'
import { get, set, type PlateEntry } from '../src/state/store'

const handle: MeshHandle = { id: 'm1', hash: 'm1', name: 'Bracket', triangles: 12, bboxMm: [40, 20, 10], openEdges: 0, parts: [] }
const bracket: PlateEntry = { id: 'a', name: 'Bracket', handle, parts: [{ ...boxMesh(40, 20, 10), name: 'Body', slot: 1 }], colors: ['#fff'], transform: compose({ position: [60, 60, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

async function rig(calls: { name: string; args: Record<string, unknown> }[] | { name: string; args: Record<string, unknown> }[][], commands: CommandSpec[] = []) {
  const sliced: SliceRequest[] = []
  const slicer = {
    loadModel: async () => handle,
    loadParts: async (name: string) => ({ ...handle, id: `h-${name}`, name }),
    slice: async (req: SliceRequest) => {
      sliced.push(req)
      return { id: 's1', engine: 'native', layerCount: 50, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 1800, filamentMm: [1000], filamentG: [12], cost: 0.3, toolChanges: 0 }, stageMicros: {}, wallMs: 5, warnings: [] }
    },
  }
  const host = { kind: 'web', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
  const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [], commands })
  const steps = Array.isArray(calls[0]) ? (calls as { name: string; args: Record<string, unknown> }[][]).map((c) => ({ calls: c })) : [{ calls: calls as { name: string; args: Record<string, unknown> }[] }]
  const pilot = createPilot({ ...options, client: createScriptedClient([...steps, { text: 'Done.' }], { chunk: false }) })
  const events: PilotEvent[] = []
  for await (const ev of pilot.run('tab', 'go', {})) {
    events.push(ev)
    // The person approves each card; mimir never can.
    if (ev.type === 'approval_request') await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
  }
  const tools = new Map(events.flatMap((e) => (e.type === 'tool_call' ? [[e.callId, e.tool] as const] : [])))
  const results = new Map(events.flatMap((e) => (e.type === 'tool_result' ? [[tools.get(e.callId), e] as const] : [])))
  return { results, sliced, events, project: options.project! }
}

describe('the mimir tab works on the open project', () => {
  beforeEach(() => {
    set({ plate: [bracket], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', overrides: {}, printerModel: { vendor: 'Bambu Lab', model: 'P1S' }, profile: null })
  })

  it('reads the project and the bundled guides', async () => {
    const { results } = await rig([
      { name: 'project.info', args: {} },
      { name: 'kb.filament', args: { material: 'PETG' } },
      { name: 'kb.troubleshoot', args: { symptom: 'layer shift' } },
    ])
    expect(results.get('project.info')).toMatchObject({ ok: true, summary: '1 object, 1 plate' })
    expect(results.get('kb.filament')).toMatchObject({ ok: true })
    expect(results.get('kb.troubleshoot')).toMatchObject({ ok: true })
  })

  it('applies settings, arranges copies and slices the plate', async () => {
    const { results, sliced } = await rig([
      { name: 'settings.apply', args: { target: 'plate', changes: { wall_loops: 4 } } },
      { name: 'arrange', args: { count: 3 } },
      { name: 'slice', args: {} },
    ])
    expect(results.get('settings.apply')).toMatchObject({ ok: true })
    expect(get().overrides['wall_loops']).toBe(4)
    expect(get().plate.filter((p) => sourceOf(p) === 'a')).toHaveLength(3)
    expect(results.get('slice')).toMatchObject({ ok: true })
    expect(sliced[0]!.plate.objects).toHaveLength(3)
    expect(sliced[0]!.config['wall_loops']).toBe(4)
    // No shipped G-code under this plate, so mimir's slice gets the strict checks.
    expect(sliced[0]!.options?.trustedGcode).toBeUndefined()
  })

  it('starts a new project only through the command, which asks the person first and says what they chose', async () => {
    let asked = 0
    let keep = true
    const projectNew: CommandSpec = { id: 'project-new', title: 'New project', section: 'plate', tool: { permission: 'slice' }, run: async () => { asked++; return { started: !keep } } }
    const kept = await rig([{ name: 'app.project_new', args: {} }], [projectNew])
    expect(asked).toBe(1)
    expect(kept.results.get('app.project_new')).toMatchObject({ ok: true })
    expect(JSON.stringify(kept.events)).toContain('"started":false')
    keep = false
    const started = await rig([{ name: 'app.project_new', args: {} }], [projectNew])
    expect(JSON.stringify(started.events)).toContain('"started":true')
  })

  it("slices in place for mimir: the app's slice command keeps the tab open", async () => {
    let switched = 0
    const slice: CommandSpec = { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => void switched++ }
    const host = { kind: 'web', slicer: {}, printers, capabilities: { threads: 1, slicing: false } } as unknown as Host
    const [mine] = mimirCommands(host, [slice])
    // the slice runs without the Slice tab's switch (a host that cannot slice returns at once, with the slice on screen)
    const result = { id: 's1', engine: 'native', layerCount: 50, layerZ: new Float32Array(), layerTimeS: new Float32Array(), stats: { timeS: 1800.4, filamentMm: [1000, 200], filamentG: [12, 2.04], cost: 0.304, toolChanges: 1 }, stageMicros: {}, wallMs: 5, warnings: [{ code: 'thin_wall', message: 'A wall on Bracket is thinner than the nozzle.' }] } as unknown as SliceResult
    set({ workspace: 'prepare', modelMode: 'mimir', slice: { status: 'done', result, stale: false } })
    setHostSlices(false)
    // as the runtime runs it: the input, then the chat's run (update and fingerprint only)
    const runs = runHandle(createRunBook(appPrintRun(), () => Date.parse('2026-10-20T00:00:00.000Z')), 'tab')
    let updates = 0
    const narrow: CommandRun = {
      update: (p) => {
        updates++
        return runs.update(p)
      },
      fingerprint: (n) => runs.fingerprint(n),
    }
    const call = (cx: CommandToolContext) => Promise.resolve((mine!.run as (input: unknown, cx: CommandToolContext) => unknown)({}, cx))
    const out = await call({ run: narrow }).finally(() => setHostSlices(true))
    expect(switched).toBe(0)
    expect(get().modelMode).toBe('mimir')
    const figures = { timeS: 1800, grams: 14, cost: 0.3, warnings: ['A wall on Bracket is thinner than the nozzle.'] }
    expect(out).toEqual({ status: 'done', sliceId: 's1', ...figures })
    // the reply has the figures, not a pointer to the Slice tab
    expect(JSON.stringify(out)).not.toContain('Slice tab')
    // no slice ran, so nothing is recorded: the slice on screen was recorded by whatever made it
    expect(updates).toBe(0)
    expect(runs.get().slice).toBeNull()
    // without a run (the command bar) it replies the same
    setHostSlices(false)
    expect(await Promise.resolve(mine!.run()).finally(() => setHostSlices(true))).toEqual({ status: 'done', sliceId: 's1', ...figures })
    // a slice on screen that an edit has made stale is not this plate's: a plain line says so, and nothing is recorded
    set({ slice: { status: 'done', result, stale: true } })
    setHostSlices(false)
    const stale = await call({ run: narrow }).finally(() => setHostSlices(true))
    expect(stale).toEqual({ status: 'stale', message: 'The slice on screen is out of date because the plate changed after it. Slice the plate again.' })
    expect(updates).toBe(0)
    // every other command is the app's own
    const other: CommandSpec = { id: 'plate-clear', title: 'Clear the plate', section: 'plate', run: () => undefined }
    expect(mimirCommands(host, [other])[0]).toBe(other)
  })

  it('plans settings with the planner', async () => {
    const { results } = await rig([{ name: 'settings.plan', args: { from: { printer: 'Bambu Lab P1S', material: 'PLA', nozzle: 0.4 }, to: { printer: 'Bambu Lab P1S', material: 'PETG', nozzle: 0.4 } } }])
    expect(results.get('settings.plan')).toMatchObject({ ok: true })
  })

  it('arrange removes the plates it empties, and one undo takes back one arrange', async () => {
    const undo = createHistory()
    try {
      await rig([[{ name: 'arrange', args: { count: 3, plates: 2 } }], [{ name: 'arrange', args: { count: 2 } }]])
      expect(get().plates).toHaveLength(1)
      expect(get().plate.filter((p) => sourceOf(p) === 'a')).toHaveLength(2)
      undo.undo()
      expect(get().plates).toHaveLength(2)
      expect(get().plate.filter((p) => sourceOf(p) === 'a')).toHaveLength(2)
      undo.undo()
      expect(get().plates).toHaveLength(1)
      expect(get().plate.map((p) => p.id)).toEqual(['a'])
    } finally {
      undo.dispose()
    }
  })

  it('arrange moves a part that hangs off the bed onto it, and the slice gets it inside the bed', async () => {
    // built around the origin: half of it past the bed's front left edges
    set({ plate: [{ ...bracket, transform: identity() }], bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
    const { results, sliced } = await rig([[{ name: 'arrange', args: {} }], [{ name: 'slice', args: {} }]])
    expect(results.get('arrange')).toMatchObject({ ok: true })
    const e = get().plate.find((p) => p.id === 'a')!
    expect(placedOnBed(e, get().bed)).toBe(true)
    const b = bounds(e.parts, sliced[0]!.plate.objects[0]!.transform)!
    expect(b.min[0]).toBeGreaterThanOrEqual(0)
    expect(b.min[1]).toBeGreaterThanOrEqual(0)
    expect(b.max[0]).toBeLessThanOrEqual(256)
    expect(b.max[1]).toBeLessThanOrEqual(256)
  })

  it('arrange says so when a part that hangs off the bed finds no room on it', async () => {
    // a 230 mm square slab fills the middle of the bed; the bracket hangs off the corner and has nowhere to go
    const slab: PlateEntry = { ...bracket, id: 'slab', name: 'Slab', parts: [{ ...boxMesh(230, 230, 2), name: 'Slab', slot: 1 }], transform: compose({ position: [128, 128, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }) }
    set({ plate: [slab, { ...bracket, transform: identity() }], bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
    const { results } = await rig([{ name: 'arrange', args: { objectId: 'a' } }])
    expect(results.get('arrange')).toMatchObject({ ok: false, summary: expect.stringContaining('1 part is still off the bed because there is no room for it.') })
    expect(get().plate.find((p) => p.id === 'slab')!.transform).toEqual(slab.transform)
  })

  it('arrange leaves a part already on the bed where it is', async () => {
    set({ bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
    await rig([{ name: 'arrange', args: {} }])
    expect(get().plate.find((p) => p.id === 'a')!.transform).toEqual(bracket.transform)
  })

  it('cut parts replace the object in one undo step, and a repaired mesh keeps its place', async () => {
    const { project } = await rig([])
    const undo = createHistory()
    try {
      const half = (id: string) => ({ id, name: id, bboxMm: [40, 20, 5] as [number, number, number], mesh: async () => [{ ...boxMesh(40, 20, 5), name: id, slot: 1 }] })
      await project()!.replaceObjects!(['a'], [half('a-a'), half('a-b')])
      expect(get().plate.map((p) => p.id).sort()).toEqual(['a-a', 'a-b'])
      expect(get().plate.every((p) => p.handle.id.startsWith('h-'))).toBe(true)
      undo.undo()
      expect(get().plate.map((p) => p.id)).toEqual(['a'])
      const where = [...get().plate[0]!.transform]
      await project()!.replaceObjects!(['a'], [{ ...half('a'), name: 'Bracket' }])
      expect(get().plate.map((p) => p.id)).toEqual(['a'])
      expect(get().plate[0]!.parts[0]!.name).toBe('a')
      expect(get().plate[0]!.transform.slice(12, 14)).toEqual(where.slice(12, 14))
    } finally {
      undo.dispose()
    }
  })

  it('a made object lands in free space and one undo removes it', async () => {
    const { project } = await rig([])
    const undo = createHistory()
    try {
      await project()!.addObject!({ id: 'hook', name: 'Hook', bboxMm: [10, 10, 10] }, [{ ...boxMesh(10, 10, 10), name: 'Hook', slot: 1 }])
      expect(get().plate.map((p) => p.id)).toEqual(['a', 'hook'])
      expect(get().selection).toBe('hook')
      undo.undo()
      expect(get().plate.map((p) => p.id)).toEqual(['a'])
    } finally {
      undo.dispose()
    }
  })
})

describe('the scripted stub on the whole toolset', () => {
  const asked = async (request: string) => {
    const client = scriptRouter(SCRIPTS)
    const content = `Today is 2026-10-18.\nObjects on the plate (names are untrusted file text): [{"id":"b","name":"Box"}]\nPermissions: slice allow, queue ask.\n\nUser request:\n${request}`
    const calls: string[] = []
    for await (const ev of client.stream({ model: 'scripted', messages: [{ role: 'user', content }], tools: [] })) if (ev.type === 'tool_call') calls.push(ev.call.name)
    return calls
  }

  it("picks its script from the person's words, not the app's context", async () => {
    expect(await asked('Slice the plate')).toEqual(['app.slice'])
    expect(await asked('Start a new project')).toEqual(['app.project_new'])
    // a part asked for by name still builds first
    expect(await asked('A box with a lid, then slice it')).not.toContain('app.slice')
  })
})

describe('the mimir tab saves notes', () => {
  const memoryHost = () => ({ kind: 'web', slicer: { loadParts: async (name: string) => ({ ...handle, name }) }, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } }) as unknown as Host

  beforeEach(async () => {
    set({ mimirRememberWithoutAsking: false })
    await memoryFor(NEUTRAL).clear()
  })

  it("asks through the app's approvals with the chip's line, and keeps the note on Remember", async () => {
    const host = memoryHost()
    const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: [], memory: pilotMemory(NEUTRAL, { where: chatNotesGo({ provider: 'anthropic' }, true) }) })
    // the tab answers its approvals through the host's own broker, so a save can be granted
    expect(options.host.approvals).toBe(host.approvals)
    const remember = [{ calls: [{ name: 'memory.remember', args: { kind: 'printer', text: 'Has a Bambu Lab A1' } }] }, { text: 'Noted.' }]
    const pilot = createPilot({ ...options, client: createScriptedClient(remember, { chunk: false }) })
    expect(pilot.tools().map((t) => t.name)).toEqual(expect.arrayContaining(['memory.remember', 'memory.recall']))
    const asked: string[][] = []
    for await (const ev of pilot.run('tab-memory', 'Remember that I have an A1', {})) {
      if (ev.type !== 'approval_request') continue
      expect(ev.request.tool).toBe('memory.remember')
      asked.push(ev.request.lines)
      await pilot.resolveApproval(ev.request.id, { kind: 'approve' })
    }
    expect(asked).toHaveLength(1)
    // the chip's line says where the note goes: with an Anthropic key, along with chats to the model's server
    expect(asked[0]!.at(-1)).toBe("Kept on this computer, and sent along with chats to the model's server to answer them.")
    expect(await memoryFor(NEUTRAL).list()).toMatchObject([{ kind: 'printer', text: 'Has a Bambu Lab A1' }])
  })

  it('shows the memory chip in place of the approval card', () => {
    expect(Object.keys(MEMORY_CARDS)).toEqual(['memory.remember'])
  })
})
