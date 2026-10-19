// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's runtime on the open project, through the same options the tab makes it with: the project, the
// guides, settings, arrange and slicing (approvals stay with the person), New project behind the discard question, and
// a slice that keeps the tab on screen.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Host, MeshHandle, PilotEvent, PrinterHost, SliceRequest } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG } from '@slicerx/pilot'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { mimirCommands, tabPilotOptions } from '../src/workspaces/mimir/session'
import { scriptRouter } from '../src/workspaces/mimir/scripted'
import { SCRIPTS } from '../src/workspaces/mimir/scripts'
import type { CommandSpec } from '@slicerx/contracts'
import { sourceOf } from '../src/plate/edit'
import { createHistory } from '../src/plate/history'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'
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
    // the slice runs without the Slice tab's switch (a host that cannot slice returns at once)
    set({ workspace: 'prepare', modelMode: 'mimir' })
    setHostSlices(false)
    const out = await Promise.resolve(mine!.run()).finally(() => setHostSlices(true))
    expect(switched).toBe(0)
    expect(get().modelMode).toBe('mimir')
    expect(out).toMatchObject({ status: expect.any(String) })
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
