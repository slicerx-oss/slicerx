// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab sets the project's filaments: project.add_filament and project.set_filament change the slots the way
// the filament rail and its dialog do and answer with every filament as the rail now shows it, so the parts on screen
// take the colors mimir picked. The part makers take the filament of the part they make, and one past the project's
// last filament adds it and says so. A scripted run of a small toy train, as the tab's runtime runs it, ends with each
// part in its planned color.
import type { Host, MeshHandle, PilotEvent, PrinterHost } from '@slicerx/contracts'
import { createApprovalBroker, createPilot, createScriptedClient, DEFAULT_CONFIG, type PilotTool, type ScriptStep } from '@slicerx/pilot'
import { beforeEach, describe, expect, it } from 'vitest'
import { effectiveSlot, resolveSlots } from '../src/filament/slots'
import { filamentColors } from '../src/plate/texture-paint'
import { get, set } from '../src/state/store'
import { bundledKb } from '../src/workspaces/mimir/kb'
import { clearPlans } from '../src/workspaces/mimir/plan-tool'
import { tabPilotOptions, toolsFor } from '../src/workspaces/mimir/session'
import { useGeomEngine } from './geom-engine'

useGeomEngine('mimir-tab-filaments-replies', { compressed: true, freshCache: true })

const loader = { loadParts: async (name: string): Promise<MeshHandle> => ({ id: name, hash: name, name, triangles: 12, bboxMm: [20, 10, 8], openEdges: 0, parts: [] }) }
const tools = (): Map<string, PilotTool<never>> => new Map(toolsFor(loader).map((t) => [t.name, t]))

/** One tool call as the runtime makes it: the input checked against the tool's schema, then run. */
async function call(name: string, args: Record<string, unknown>) {
  const t = tools().get(name)
  if (!t) throw new Error(`the tab has no ${name}`)
  const input = t.input.parse(args) as never
  return t.run(input, {} as never)
}

const fresh = () => {
  clearPlans()
  set({ plate: [], plates: [{ id: 'p1', name: 'Plate 1', objects: [], settings: { sequence: 'by-layer' } }], activePlate: 'p1', selection: null, selectedIds: [], historyEdit: null, slotSetup: {}, printerSlots: [], fileSlotColors: [], fileSlotTypes: [] })
}

/** Every part on the plate: its name, the filament it prints in and that filament's color on screen. */
function partColors(): { name: string; slot: number; color: string }[] {
  const colors = filamentColors()
  return get().plate.flatMap((e) => e.parts.map((p) => ({ name: p.name, slot: effectiveSlot(e, p), color: colors[effectiveSlot(e, p) - 1] ?? '' })))
}

describe('the tab sets the filaments', () => {
  beforeEach(fresh)

  it('adds a filament and sets one, answering with every filament as the rail shows it', async () => {
    expect(resolveSlots(get())).toHaveLength(1)
    const added = await call('project.add_filament', { type: 'petg', color: '#FF5500' })
    expect(added).toMatchObject({ summary: 'Added filament 2: PETG #ff5500', output: { filament: { slot: 2, type: 'PETG', color: '#ff5500' } } })
    expect((added.output as { filaments: unknown[] }).filaments).toHaveLength(2)
    const changed = await call('project.set_filament', { slot: 1, color: '1a1a1a' })
    expect(changed).toMatchObject({ summary: 'Set filament 1: PLA #1a1a1a', output: { filament: { slot: 1, type: 'PLA', color: '#1a1a1a' } } })
    // the rail, and the colors the viewport paints the parts with, read the same slots
    expect(resolveSlots(get()).map((r) => [r.index, r.type, r.color, r.source])).toEqual([
      [1, 'PLA', '#1a1a1a', 'user'],
      [2, 'PETG', '#ff5500', 'user'],
    ])
    expect(filamentColors()).toEqual(['#1a1a1a', '#ff5500'])
  })

  it('refuses a filament it cannot set, in plain words, and changes nothing', async () => {
    expect(await call('project.set_filament', { slot: 1 })).toMatchObject({ ok: false, summary: 'Give a type, a color or both.' })
    expect(await call('project.set_filament', { slot: 3, color: '#ffffff' })).toMatchObject({ ok: false, summary: 'No filament 3: the project has 1. Add one with project.add_filament.' })
    expect(await call('project.add_filament', { color: 'navy blue' })).toMatchObject({ ok: false, summary: expect.stringContaining('is not a color') })
    expect(await call('project.set_filament', { slot: 1, type: 'Wood' })).toMatchObject({ ok: false, summary: expect.stringContaining('Use one of PLA, PETG') })
    expect(get().slotSetup).toEqual({})
  })

  it('builds a part in a filament past the last, which adds it and says so', async () => {
    const { output } = (await call('design.new', { name: 'Tag' })) as { output: { design: string } }
    const built = await call('geom.build', { design: output.design, name: 'Base', slot: 3, solids: [{ type: 'box', min: [-20, -10, 0], max: [20, 10, 3] }] })
    expect(built.ok).not.toBe(false)
    expect(built.summary).toContain('The project had 1 filament, so filaments 2 (PLA #282a36), 3 (PLA #ff5555) were added with the default color. Set the color with project.set_filament.')
    expect(built.output).toMatchObject({ filamentsAdded: [{ slot: 2 }, { slot: 3 }] })
    expect(resolveSlots(get()).map((r) => r.source)).toEqual(['default', 'user', 'user'])
    // a slot the project has already adds nothing
    const again = await call('geom.build', { design: output.design, name: 'Rim', slot: 2, solids: [{ type: 'box', min: [-20, -10, 3], max: [20, -8, 5] }] })
    expect(again.summary).not.toContain('added')
    expect(partColors().map((p) => [p.name, p.slot])).toEqual([
      ['Base', 3],
      ['Rim', 2],
    ])
  }, 60_000)

  it('extrudes and embosses a new part in its own filament, which an undo and redo keep', async () => {
    const { output } = (await call('design.new', { name: 'Keychain' })) as { output: { design: string } }
    const design = output.design
    await call('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 16 }, distance_mm: 3, name: 'Tag' })
    const text = await call('geom.emboss', { design, text: 'SX', point: [0, 0, 3], normal: [0, 0, 1], size_mm: 8, depth_mm: 1, slot: 2 })
    expect(text.ok).not.toBe(false)
    const ring = await call('geom.extrude', { design, shape: { type: 'circle', diameterMm: 8 }, placement: { center: [26, 0] }, distance_mm: 3, slot: 3, name: 'Ring' })
    expect(ring.ok).not.toBe(false)
    expect(partColors().map((p) => [p.name, p.slot])).toEqual([
      ['Tag', 1],
      ['Text SX', 2],
      ['Ring', 3],
    ])
    await call('design.undo', { design })
    await call('design.redo', { design })
    expect(partColors().map((p) => [p.name, p.slot])).toEqual([
      ['Tag', 1],
      ['Text SX', 2],
      ['Ring', 3],
    ])
    // a join changes a part that keeps its own filament
    await expect(call('geom.extrude', { design, shape: { type: 'circle', diameterMm: 4 }, distance_mm: 1, operation: 'join', slot: 2 })).rejects.toThrow('slot: a join changes a part that keeps its own filament')
    await expect(call('geom.emboss', { design, text: 'X', point: [0, 0, 3], normal: [0, 0, 1], size_mm: 4, depth_mm: 0.6, mode: 'deboss', slot: 2 })).rejects.toThrow('debossed text is a pocket')
  }, 60_000)
})

const printers = { list: async () => [], plugins: async () => [], fleets: async () => [], status: async () => { throw new Error('none') }, subscribe: () => () => undefined } as unknown as PrinterHost
const noLlm = { available: async () => true, stream: () => { throw new Error('scripted') } }

/** The colors the toy train is planned in, by filament. */
const PLAN = { 1: '#1a1a1a', 2: '#f4f1e8', 3: '#c8a165', 4: '#b22222', 5: '#6b4423' } as const

const body = (z: number, h: number) => ({ type: 'prism', points: [[-100, -12], [90, -12], [110, 0], [90, 12], [-100, 12]], origin: [0, 0, z], axis: [0, 0, 1], heightMm: h })
const chimney = (x: number) => ({ type: 'cylinder', origin: [x, 0, 30], axis: [0, 0, 1], diameterMm: 7, heightMm: 16 })
const pole = (x: number) => ({ type: 'cylinder', origin: [x, 0, 20], axis: [0, 0, 1], diameterMm: 2, heightMm: 30 })

describe('a scripted toy train in the tab', () => {
  beforeEach(fresh)

  it('ends assembled on the plate with every part in its planned color', async () => {
    const steps: ScriptStep[] = [
      { calls: [{ name: 'pilot.sheet', args: { title: 'toy train', dims: [{ key: 'length', label: 'Length', value: 210, unit: 'mm', source: 'asked' }] } }] },
      { calls: [{ name: 'design.new', args: { name: 'toy train' } }] },
      { calls: [{ name: 'geom.build', args: { design: 'DESIGN', name: 'Lower body', slot: 4, solids: [body(0, 8)] } }] },
      { calls: [{ name: 'geom.build', args: { design: 'DESIGN', name: 'Upper body', slot: 1, solids: [body(8, 12)] } }] },
      { calls: [{ name: 'geom.build', args: { design: 'DESIGN', name: 'Cab', slot: 2, solids: [{ type: 'box', min: [-60, -9, 20], max: [50, 9, 30] }] } }] },
      { calls: [{ name: 'geom.build', args: { design: 'DESIGN', name: 'Chimneys', slot: 3, solids: [chimney(-35), chimney(-12), chimney(11), chimney(34)] } }] },
      { calls: [{ name: 'project.add_filament', args: { type: 'PLA', color: PLAN[5] } }] },
      { calls: [{ name: 'geom.build', args: { design: 'DESIGN', name: 'Poles', slot: 5, solids: [pole(-85), pole(80)] } }] },
      {
        calls: [
          { name: 'project.set_filament', args: { slot: 1, color: PLAN[1] } },
          { name: 'project.set_filament', args: { slot: 2, color: PLAN[2] } },
          { name: 'project.set_filament', args: { slot: 3, color: PLAN[3] } },
          { name: 'project.set_filament', args: { slot: 4, color: PLAN[4] } },
        ],
      },
      { text: 'Your toy train is on the plate: black body, red base, white cab, buff chimneys and brown poles.' },
    ]
    // the design id design.new answered with goes into the later calls, as a model reads it from the reply
    const designIn = (m: unknown): string => /design\\*"\s*:\s*\\*"([\w~-]+)/.exec(JSON.stringify(m))?.[1] ?? ''
    const withDesign = (calls: { name: string; args: Record<string, unknown> }[], m: unknown) => calls.map((c) => ({ ...c, args: JSON.parse(JSON.stringify(c.args).replaceAll('"DESIGN"', JSON.stringify(designIn(m)))) as Record<string, unknown> }))
    const script = steps.map((s) => (typeof s === 'function' || !('calls' in s) ? s : (m: unknown) => ({ calls: withDesign(s.calls as { name: string; args: Record<string, unknown> }[], m) }))) as ScriptStep[]
    const slicer = { loadModel: async () => Promise.reject(new Error('not here')), loadParts: loader.loadParts, slice: async () => Promise.reject(new Error('not here')) }
    const host = { kind: 'web', slicer, printers, approvals: createApprovalBroker(), capabilities: { threads: 1 } } as unknown as Host
    const options = tabPilotOptions(host, { llm: noLlm, config: DEFAULT_CONFIG, kb: await bundledKb(), tools: toolsFor(loader), commands: [] })
    const pilot = createPilot({ ...options, client: createScriptedClient(script, { chunk: false }) })
    const names = new Map<string, string>()
    const results: { tool: string; ok: boolean; summary: string }[] = []
    for await (const e of pilot.run('tab', 'make a toy train, keep the details simple, then color each part', {}) as AsyncIterable<PilotEvent>) {
      if (e.type === 'sheet') void pilot.answerSheet!(e.sheet.id, {})
      if (e.type === 'approval_request') await pilot.resolveApproval(e.request.id, { kind: 'approve' })
      if (e.type === 'tool_call') names.set(e.callId, e.tool)
      if (e.type === 'tool_result') results.push({ tool: names.get(e.callId) ?? '', ok: e.ok, summary: e.summary })
    }
    expect(results.filter((r) => !r.ok)).toEqual([])
    expect(results.map((r) => r.tool)).toEqual(['pilot.sheet', 'design.new', 'geom.build', 'geom.build', 'geom.build', 'geom.build', 'project.add_filament', 'geom.build', 'project.set_filament', 'project.set_filament', 'project.set_filament', 'project.set_filament'])
    // the first part in filament 4 added filaments 2 to 4, which the person never had to ask for
    expect(results[2]!.summary).toContain('filaments 2 (PLA #282a36), 3 (PLA #ff5555), 4 (PLA #50fa7b) were added')
    // one assembled object, each part in its planned color, and five filaments on the rail
    expect(get().plate).toHaveLength(1)
    expect(partColors()).toEqual([
      { name: 'Lower body', slot: 4, color: PLAN[4] },
      { name: 'Upper body', slot: 1, color: PLAN[1] },
      { name: 'Cab', slot: 2, color: PLAN[2] },
      { name: 'Chimneys', slot: 3, color: PLAN[3] },
      { name: 'Poles', slot: 5, color: PLAN[5] },
    ])
    expect(resolveSlots(get()).map((r) => r.color)).toEqual([PLAN[1], PLAN[2], PLAN[3], PLAN[4], PLAN[5]])
  }, 120_000)
})
