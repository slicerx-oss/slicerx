// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import type { ApprovalToken, PilotMachine, PluginManifest, PrinterHost } from '@slicerx/contracts'
import { hashParams } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, createEvalSlicer, type EvalObject } from '../evals/harness'
import { createFakeHosts, HISTORY, PETG_V1, type FakeHosts } from '../evals/fakes'
import { runScenario } from '../evals/runner'
import { FUNCTION_SCENARIOS, SCENARIOS } from '../evals/skills/d'
import { EXPECTED_REFUSALS, runFunctionScenario } from '../evals/functions'
import { createScriptedClient } from '../src/provider/scripted'
import { buildApprovalRequest } from '../src/runtime'
import { createShared } from '../src/shared'
import { toolSpec, type PilotTool, type ToolContext } from '../src/tool'
import { create as batchD } from '../skills/batch-d'
import { colorDistance } from '../skills/d_common/index'
import { createSlice } from '../skills/slice/index'

const MACHINE: PilotMachine = { printer: 'bambu_x1c', material: 'petg', nozzle: 0.4 }
const OBJECTS: EvalObject[] = [{ id: 'bracket', name: 'Shelf bracket', bboxMm: [80, 40, 30] }]

/** A run environment with the fake hosts and a way to build tool contexts and approved tokens. */
function setup(printers?: (env: ReturnType<typeof createEvalEnv>) => PrinterHost) {
  const holder: { fake?: FakeHosts } = {}
  const env = createEvalEnv({
    client: createScriptedClient([]),
    machine: MACHINE,
    objects: OBJECTS,
    hosts: (e) => {
      holder.fake = createFakeHosts(e)
      return holder.fake.hosts
    },
  })
  const fake = holder.fake
  if (!fake) throw new Error('fake hosts missing')
  const shared = createShared()
  const tools = new Map(batchD(shared).map((t) => [t.name, t as unknown as PilotTool<Record<string, unknown>>]))
  const host = printers?.(env) ?? env.sim
  const ctxFor = (callId: string, token?: ApprovalToken): ToolContext => {
    const ctx: ToolContext = {
      host: { printers: host, slicer: createEvalSlicer(() => env.project), profiles: fake.profiles, ...fake.hosts },
      sessionId: 's1',
      callId,
      signal: new AbortController().signal,
      context: { machine: MACHINE },
      today: '2026-09-30',
      project: env.project,
      kb: env.kb,
      progress: () => undefined,
    }
    if (token) ctx.token = token
    return ctx
  }
  const tool = (name: string): PilotTool<Record<string, unknown>> => {
    const t = tools.get(name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }
  /** Approve a call the way the runtime does and return the token. */
  async function approve(name: string, input: Record<string, unknown>, callId = 'approve'): Promise<ApprovalToken> {
    const req = await buildApprovalRequest(tool(name), input, ctxFor(callId), { id: `apr_${name}_${callId}`, sessionId: 's1', expiresAt: new Date(Date.parse('2026-09-30T14:05:00Z')).toISOString() })
    await env.broker.register(req)
    return env.broker.grant(req.id)
  }
  return { env, fake, shared, tool, ctxFor, approve }
}

describe('skill batch d scenarios replay', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s passes', async (_id, s) => {
    const rec = await runScenario(s, { mode: 'replay', model: 'scripted', run: 1 })
    expect({ pass: rec.score.pass, notes: rec.score.notes }).toMatchObject({ pass: true })
    expect(rec.score.unapprovedSideEffects).toBe(0)
  })
})

describe('tool definitions', () => {
  it('describe every input field and every tool', () => {
    for (const t of batchD(createShared())) {
      const spec = toolSpec(t)
      expect(spec.description.length, t.name).toBeGreaterThan(40)
      const props = (spec.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {}
      for (const [k, v] of Object.entries(props)) expect(v.description, `${t.name}.${k}`).toBeTruthy()
    }
  })

  it('provides every tool the skill catalog needs from this batch', () => {
    const names = batchD(createShared()).map((t) => t.name)
    for (const n of ['kb.sources', 'ams_mapping', 'multicolor_assign', 'region_modifiers', 'printer_config_check']) {
      expect(names).toContain(n)
    }
  })
})

describe('ams_mapping', () => {
  it('maps loaded slots, plans a swap, and keeps TPU off the AMS', async () => {
    const { tool, ctxFor } = setup()
    const out = await tool('ams_mapping').run(
      { printerId: 'bay-1', needs: [{ material: 'PLA', color: '#f2f2f2' }, { material: 'PETG', color: '#3b82f6' }, { material: 'TPU 95A' }, { material: 'ABS', color: 'black' }] },
      ctxFor('c1'),
    )
    const res = out.output as { assignments: { material: string; status: string; slot?: string }[]; slotMap: Record<string, string> }
    expect(res.assignments.map((a) => `${a.material}:${a.status}`)).toEqual(['PLA:match', 'PETG:match', 'TPU 95A:external', 'ABS:swap'])
    expect(res.slotMap).toEqual({ '0': 'A1', '1': 'A3' })
    expect(out.untrusted).toBe(true)
  })

  it('uses the project material when no list is given and says why', async () => {
    const { tool, ctxFor } = setup()
    const out = await tool('ams_mapping').run({ printerId: 'bay-2' }, ctxFor('c1'))
    expect((out.output as { notes: string[] }).notes.join(' ')).toMatch(/per-part filament data/)
  })

  it('measures color distance', () => {
    expect(colorDistance('#ef4444', 'red')).toBeLessThan(40)
    expect(colorDistance('white', 'black')).toBeGreaterThan(300)
    expect(colorDistance('nonsense', 'red')).toBeNull()
  })
})

describe('planners never claim to apply anything', () => {
  it.each([
    ['multicolor_assign', { regions: [{ region: 'base', filament: { material: 'PLA', color: 'white' }, fromZ: 0, toZ: 10 }, { region: 'top', filament: { material: 'PLA', color: 'blue' }, fromZ: 10, toZ: 30 }] }],
    ['region_modifiers', { goals: ['strong_holes', 'thin_walls'] }],
  ])('%s returns a plan and leaves the project alone', async (name, input) => {
    const { tool, ctxFor, env } = setup()
    const out = await tool(name).run(input, ctxFor('c1'))
    expect((out.output as { applied: boolean }).applied).toBe(false)
    expect(out.summary).toMatch(/nothing applied/i)
    expect(env.project.appliedOverrides()).toEqual({})
    expect(env.audit.sideEffects).toEqual([])
  })

  it('orders color changes by height and counts layers', async () => {
    const { tool, ctxFor } = setup()
    const out = await tool('multicolor_assign').run(
      { regions: [{ region: 'top', filament: { material: 'PLA', color: 'blue' }, fromZ: 20, toZ: 30 }, { region: 'base', filament: { material: 'PLA', color: 'white' }, fromZ: 0, toZ: 20 }] },
      ctxFor('c1'),
    )
    const order = (out.output as { colorChangeOrder: { layer: number; z: number }[] }).colorChangeOrder
    expect(order).toHaveLength(1)
    expect(order[0]?.z).toBe(20)
    expect(order[0]?.layer).toBe(100)
  })
})

describe('region_modifiers apply', () => {
  it('rings each named hole with a modifier, sets the feature-only keys on the object, and reads them back', async () => {
    const { tool, ctxFor, env } = setup()
    const input = { goals: ['strong_holes', 'flat_tops', 'overhangs'], objectId: 'bracket', apply: true, holes: [{ center: [10, 20, 15], diameter: 5 }] }
    const plan = await tool('region_modifiers').approval?.(input, ctxFor('a1'))
    expect(plan?.title).toBe('Add 1 modifier and 3 object settings to Shelf bracket?')
    expect(plan?.lines).toContain('Modifier: cylinder 11 mm across (the 5 mm hole plus a 3 mm ring), 30 mm tall, at [10, 20, 15]: wall_loops 2 -> 4')
    const out = await tool('region_modifiers').run(input, ctxFor('c1'))
    const res = out.output as { applied: boolean; objectSettings: Record<string, unknown>; volumes: { id: string; shape: unknown; centerMm: number[]; settings: Record<string, unknown>; what: string }[]; left: { goal: string; keys: string[] }[]; readBack: { objectSettings: Record<string, unknown>; volumes: { id: string; role: string; settings?: Record<string, unknown> }[] } }
    expect(res.applied).toBe(true)
    expect(res.objectSettings).toEqual({ ironing_type: 'top', ironing_speed: 20, enable_overhang_speed: true })
    expect(res.volumes).toEqual([
      expect.objectContaining({ id: 'vol-1', shape: { kind: 'cylinder', diameterMm: 11, heightMm: 30 }, centerMm: [10, 20, 15], settings: { wall_loops: 4 } }),
    ])
    // The overhang slowdown would slow every outer wall, so with no region named it stays a plan.
    expect(res.left).toEqual([expect.objectContaining({ goal: 'overhangs', keys: ['outer_wall_speed'] })])
    expect(res.readBack.objectSettings).toEqual(res.objectSettings)
    expect(res.readBack.volumes).toEqual([{ id: 'vol-1', name: 'Hole ring 5 mm', role: 'modifier', settings: { wall_loops: 4 } }])
    expect(env.project.addedVolumes).toEqual([expect.objectContaining({ objectId: 'bracket', role: 'modifier', centerMm: [10, 20, 15] })])
    expect(env.project.appliedOverrides()).toEqual({})
    expect(out.summary).toMatch(/1 modifier and 3 object settings on Shelf bracket; overhangs left as a plan/)
  })

  it('places a goal in a named region, and leaves holes unnamed as a plan', async () => {
    const { tool, ctxFor, env } = setup()
    const out = await tool('region_modifiers').run({ goals: ['strong_holes', 'thin_walls'], apply: true, regions: [{ goal: 'thin_walls', shape: { box: [10, 5, 30] }, center: [70, 20, 15] }] }, ctxFor('c1'))
    const res = out.output as { volumes: { what: string; settings: Record<string, unknown> }[]; left: { goal: string; why: string }[]; objectSettings: Record<string, unknown> }
    expect(res.objectSettings).toEqual({ detect_thin_wall: true })
    expect(res.volumes).toHaveLength(1)
    expect(res.volumes[0]?.what).toMatch(/^box 10 x 5 x 30 mm at \[70, 20, 15\]: outer_wall_speed/)
    expect(res.left).toEqual([expect.objectContaining({ goal: 'strong_holes', why: expect.stringMatching(/No holes were named/) })])
    expect(env.project.addedVolumes).toHaveLength(1)
  })

  it('stays a plan on a project that cannot hold volumes', async () => {
    const { tool, ctxFor, env } = setup()
    const ctx = ctxFor('c1')
    const { addVolume: _a, setObjectSettings: _s, ...bare } = env.project
    const out = await tool('region_modifiers').run({ goals: ['strong_holes'], apply: true, holes: [{ center: [0, 0, 0], diameter: 3 }] }, { ...ctx, project: bare })
    expect((out.output as { applied: boolean; note: string }).applied).toBe(false)
    expect((out.output as { note: string }).note).toMatch(/cannot hold volumes/)
    expect(env.project.addedVolumes).toEqual([])
  })
})

describe('printer_config_check', () => {
  it('lists findings with citations from the printer entry', async () => {
    const { tool, ctxFor } = setup()
    const out = await tool('printer_config_check').run({ printerId: 'bay-2' }, ctxFor('c1'))
    expect(out.citations?.length).toBeGreaterThan(0)
    expect((out.output as { knowledgeEntry: string }).knowledgeEntry).toBe('bambu_p1s')
    expect(out.untrusted).toBe(true)
  })

  it('warns about TPU in the AMS', async () => {
    const { tool, ctxFor } = setup()
    const out = await tool('printer_config_check').run({ printerId: 'bay-1' }, ctxFor('c1'))
    expect(JSON.stringify(out.output)).toMatch(/TPU.*not compatible with the AMS/)
  })
})

describe('kb.sources', () => {
  it('expands known ids and lists unknown ones', async () => {
    const { tool, ctxFor } = setup()
    const out = await tool('kb.sources').run({ ids: ['bambu_wiki_ams_function', 'not_a_source'] }, ctxFor('c1'))
    expect(out.citations?.map((c) => c.id)).toEqual(['bambu_wiki_ams_function'])
    expect((out.output as { missing: string[] }).missing).toEqual(['not_a_source'])
    const none = await tool('kb.sources').run({ ids: ['nothing'] }, ctxFor('c1'))
    expect(none.ok).toBe(false)
  })
})

describe('batch d app functions', () => {
  it.each(FUNCTION_SCENARIOS.map((s) => [s.id, s] as const))('%s runs as a plain function', async (_id, s) => {
    const runs = await runFunctionScenario(s)
    expect(runs.length).toBeGreaterThan(0)
    for (const r of runs) expect({ id: s.id, name: r.name, ok: r.result.ok, summary: r.result.summary }).toMatchObject({ ok: !EXPECTED_REFUSALS.has(s.id) })
  })
})
