// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A planned change to features already built (a tilt, a move) is a feature with no part of its own: design.edit_step
// records it on the step it changes (edits), and design.check's feature count counts it as built from there, so the
// count never asks for a part to stand for it. The same feature with no edit applied still fails the count. A recorded
// chat amended its plan with {"name": "Rake", "kind": "tilt"}, tilted existing steps, failed the count and then built
// a collar to make it. The host here has no engine: each step replays alone as its box, which is all a lean reads.
import { historyFiles, parseHistories, type Design as HostDesign, type DesignHost, type History, type Step } from '@slicerx/cad-history'
import type { PilotMachine } from '@slicerx/contracts'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { changeEdit, createPlanRegistry, type PartPlan } from '../src/design-check'
import { createCardPlans, tabToolset } from '../src/toolset'
import { boxTris, IDENTITY, meshOf } from './stand-host'

const machine: PilotMachine = { printer: 'bambu_a1_mini', material: 'pla', nozzle: 0.4 }
type Out = { pass: boolean; items: { name: string; pass: boolean; want: string; got: string }[] }

const frame = (z: number) => ({ origin: [0, 0, z], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] })
/** An extrude step tagged with its feature: a `w` by `h` rectangle about (cx, cy) rising `mm` from height `z`. */
const extrude = (id: string, feature: string, z: number, mm: number, w: number, h: number, cx = 20, cy = 10) => ({ id, part: 0, feature, transform: IDENTITY, params: { op: 'shape.extrude', frame: frame(z), shape: { type: 'rectangle', widthMm: w, heightMm: h }, placement: { center: [cx, cy] }, spec: { distanceMm: mm, operation: 'new' } } })
type Box = [number[], number[]]
const boxOfStep = (s: ReturnType<typeof extrude>): Box => {
  const [cx, cy] = s.params.placement.center as [number, number]
  const { widthMm: w, heightMm: h } = s.params.shape
  const z = s.params.frame.origin[2]!
  return [[cx - w / 2, cy - h / 2, z], [cx + w / 2, cy + h / 2, z + s.params.spec.distanceMm]]
}

/** A design built from `steps`, one part of their boxes, on a host whose replay of a step alone gives its box. */
function host(name: string, steps: ReturnType<typeof extrude>[]): { host: DesignHost; design: HostDesign } {
  const boxes = steps.map(boxOfStep)
  const design = {
    id: 'd1',
    name,
    history: { version: 1, base: [], steps },
    transform: IDENTITY,
    parts: [{ name, slot: 0, ...meshOf(boxes.flatMap(([lo, hi]) => boxTris(lo, hi))) }],
    status: steps.map(() => ({ state: 'done' })),
    madeBy: {},
    redo: [],
  } as unknown as HostDesign
  const h = {
    get: (id: string) => {
      if (id !== design.id) throw new Error(`no design ${id}`)
      return design
    },
    list: () => [design],
    create: async () => Promise.reject(new Error('not here')),
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    // a step alone is its box (a lean keeps its sizes, so its box is read the same)
    replayed: async (hist: History) => {
      const s = hist.steps[0] as unknown as ReturnType<typeof extrude>
      const [lo, hi] = boxOfStep(s)
      const m = meshOf(boxTris(lo, hi))
      return { parts: [{ positions: new Float32Array(m.positions), indices: new Uint32Array(m.indices) }], status: [{ state: 'done' }] }
    },
    // the boxes here meet face to face: they touch and share nothing
    call: async (op: string) => (op === 'info' ? { watertight: true } : op === 'interference' ? { interferes: false, clearanceMm: 0 } : Promise.reject(new Error('no hole there'))),
  } as unknown as DesignHost
  return { host: h, design }
}

function tab(h: DesignHost, plan: PartPlan) {
  const registry = createPlanRegistry()
  const card = createCardPlans(registry)
  const tools = tabToolset(h, card, { nozzleMm: () => machine.nozzle, newPlanId: () => plan.planId })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const ctx = { context: { project: 'creative', machine, objects: [] }, ask: async (q: { choices: { id: string }[] }) => ({ id: q.choices[0]!.id }) } as unknown as ToolContext
  const run = (name: string, input: unknown) => tool(name).run(tool(name).input.parse(input) as never, ctx)
  registry.put(plan, 'd1', 'card')
  const check = async () => {
    const r = await run('design.check', { planId: plan.planId })
    return { summary: r.summary, out: r.output as Out }
  }
  const count = async () => (await check()).out.items.find((x) => x.name === 'feature count')!
  return { run, check, count }
}

/** A desk lamp: a base, and an arm standing on it. */
const LAMP: PartPlan = {
  planId: 'plan_lamp',
  part: 'Desk lamp',
  units: 'mm',
  detail: 'basic',
  features: [
    { name: 'Base', kind: 'extrude', sizes: { length: 40, width: 20, height: 4 } },
    { name: 'Arm', kind: 'extrude', on: 'Base', sizes: { width: 4, height: 26 } },
  ],
  assumptions: [],
  questions: [],
} as PartPlan
const lamp = () => host('Desk lamp', [extrude('s1', 'Base', 0, 4, 40, 20), extrude('s2', 'Arm', 4, 26, 4, 4)])

/** A sign: a post, and a panel on it. */
const SIGN: PartPlan = {
  planId: 'plan_sign',
  part: 'Sign',
  units: 'mm',
  detail: 'basic',
  features: [
    { name: 'Post', kind: 'extrude', sizes: { width: 6, height: 30 } },
    { name: 'Panel', kind: 'extrude', on: 'Post', sizes: { width: 30, height: 16 } },
  ],
  assumptions: [],
  questions: [],
} as PartPlan
const sign = () => host('Sign', [extrude('s1', 'Post', 0, 30, 6, 6), extrude('s2', 'Panel', 30, 16, 30, 4)])

describe('a planned change to features already built', () => {
  it('is a tilt or a move by its kind, and any other kind builds a part', () => {
    for (const k of ['tilt', 'Tilt', 'lean', 'rake', 'rotate', 'rotation']) expect(changeEdit(k), k).toBe('tilt')
    for (const k of ['move', 'shift']) expect(changeEdit(k), k).toBe('move')
    for (const k of [undefined, '', 'extrude', 'loft', 'array', 'hole', 'fillet', 'paint']) expect(changeEdit(k), String(k)).toBeNull()
  })

  it('counts as built once design.edit_step tilts a step, with no new step, and the check passes', async () => {
    const { host: h, design } = lamp()
    const t = tab(h, LAMP)
    expect((await t.check()).out.pass).toBe(true)
    await t.run('design.plan', { amends: 'plan_lamp', asked: 'lean the arm back a little', add: [{ name: 'Arm lean', kind: 'tilt', sizes: {} }] })
    // planned, not yet applied: the count wants a step for it
    expect((await t.count()).pass).toBe(false)
    const edited = await t.run('design.edit_step', { design: 'd1', step: 's2', tilt: { toward: '-x', degrees: 12 } })
    expect(edited.summary).toMatch(/^Edited step 2, .*: it leans 12 degrees toward -x \(was 0\)$/)
    // the edit made no step, and the step it tilted keeps its own tag with the change it carried out
    expect(design.history.steps).toHaveLength(2)
    expect(design.history.steps[1]).toMatchObject({ feature: 'Arm', edits: ['Arm lean'] })
    expect((edited.output as { steps: { id: string; edits?: string[] }[] }).steps.find((s) => s.id === 's2')!.edits).toEqual(['Arm lean'])
    const { summary, out } = await t.check()
    expect(out.items.find((x) => x.name === 'feature count')).toMatchObject({ pass: true, want: '3 features, each built by a step tagged with its name', got: '2 steps for 3 features' })
    expect(out.pass, summary).toBe(true)
    // a second lean of another step names no change the plan has left
    await t.run('design.edit_step', { design: 'd1', step: 's2', tilt: { toward: '-x', degrees: 10 } })
    expect(design.history.steps[1]!.edits).toEqual(['Arm lean'])
    // a saved project keeps the change with the step, as it keeps the step's tag
    const files = historyFiles([{ id: 'a', history: design.history }], new Map([['a', 3]]))
    const back = parseHistories(new Map(files.map((f) => [f.name, typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data])), new Set(['3'])).get('3')!
    expect((back.steps[1] as Step).edits).toEqual(['Arm lean'])
  })

  it('still fails the count when no edit applied it', async () => {
    const { host: h, design } = sign()
    const t = tab(h, SIGN)
    await t.run('design.plan', { amends: 'plan_sign', asked: 'tilt the panel back', add: [{ name: 'Panel tilt', kind: 'tilt', sizes: {} }] })
    // a move is not the tilt the plan names, and a size edit is no change of either kind
    await t.run('design.edit_step', { design: 'd1', step: 's2', move: [1, 0, 0] })
    await t.run('design.edit_step', { design: 'd1', step: 's2', value: 17 })
    expect(design.history.steps.some((s) => s.edits)).toBe(false)
    const { out } = await t.check()
    expect(out.pass).toBe(false)
    expect(out.items.find((x) => x.name === 'feature count')).toMatchObject({ pass: false, want: '3', got: '2 steps for 3 planned features' })
  })

  it('that is a move counts once design.edit_step moves a step', async () => {
    const { host: h, design } = sign()
    const t = tab(h, SIGN)
    await t.run('design.plan', { amends: 'plan_sign', asked: 'shift the panel over', add: [{ name: 'Panel shift', kind: 'move', sizes: {} }] })
    await t.run('design.edit_step', { design: 'd1', step: 's2', move: [2, 0, 0] })
    expect(design.history.steps[1]!.edits).toEqual(['Panel shift'])
    expect((await t.count()).pass).toBe(true)
  })
})

describe("design.plan's feature description", () => {
  it('says a change to existing features has no part of its own, word for word', async () => {
    const tools = tabToolset(lamp().host, createCardPlans(createPlanRegistry()))
    expect(tools.find((t) => t.name === 'design.plan')!.description).toContain(
      "an approved plan's result gives this printer's. A change to existing features (a tilt, a move, a color) is a feature with no part of its own: never add a part to give it one. ",
    )
  })
})
