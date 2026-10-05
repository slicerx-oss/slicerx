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
