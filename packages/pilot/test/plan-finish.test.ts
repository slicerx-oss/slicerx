// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// An approved plan is built to the end in one run. A plan of many features (a Pi case: base, standoffs, five port
// cutouts, vents and a lid) takes more steps than a plain request, so the person's Go raises the run's step and tool
// call limits to fit the plan instead of stopping half way with "what is left" and waiting for "keep going".
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'
import type { ScriptStepData } from '../src/provider/scripted'

const FEATURES = ['Base', 'Hollow', 'Standoffs', 'USB-C cutout', 'Micro HDMI cutouts', 'USB cutouts', 'Ethernet cutout', 'Vents', 'Lid', 'Lid lip', 'Snap clips', 'Fillets']

function tools(accepted: boolean) {
  const built: string[] = []
  const plan = defineTool<{ part: string; features: { name: string }[] }>({
    name: 'design.plan',
    version: '1',
    description: 'Show the plan and wait for Go',
    source: 'command',
    permission: 'read',
    input: z.object({ part: z.string(), features: z.array(z.object({ name: z.string() })) }),
    async run() {
      return accepted ? { summary: 'Approved as shown', output: { planId: 'plan_1', accepted: true } } : { ok: false, summary: 'Not approved', output: { planId: 'plan_1', accepted: false } }
    },
  })
  const step = defineTool<{ name: string }>({
    name: 'geom.extrude',
    version: '1',
    description: 'One feature',
    source: 'command',
    permission: 'read',
    input: z.object({ name: z.string() }),
    async run(i) {
      built.push(i.name)
      return { summary: `Built ${i.name}` }
    },
  })
  return { list: [plan, step], built }
}

/** The plan, then each feature in a step of its own (two for the cutouts that need a sketch first), then the reply. */
function script(): ScriptStepData[] {
  const steps: ScriptStepData[] = [{ text: 'Here is the plan.', calls: [{ name: 'design.plan', args: { part: 'Pi 5 case', features: FEATURES.map((name) => ({ name })) } }] }]
  for (const name of FEATURES) {
    steps.push({ calls: [{ name: 'geom.extrude', args: { name } }] })
    if (name.includes('cutout')) steps.push({ calls: [{ name: 'geom.extrude', args: { name: `${name} sketch` } }] })
  }
  steps.push({ text: 'The case and its lid are built, with every port and vent.' })
  return steps
}

async function run(accepted: boolean) {
  const t = tools(accepted)
  const client = createScriptedClient(script(), { chunk: false })
  // the tab's limits scaled down, so the test reaches them with a short script
  const pilot = createPilot({ host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never, config: { ...DEFAULT_CONFIG, maxSteps: 10, maxToolCalls: 12 }, policy: DEFAULT_POLICY, client, builtins: false, tools: t.list as never[] })
  const events: PilotEvent[] = []
  for await (const e of pilot.run('s', 'A Pi 5 case with standoffs, port cutouts, vents and a snap-fit lid')) events.push(e)
  return { built: t.built, events, done: events.find((e) => e.type === 'done') }
}

describe('an approved plan is built to the end in one run', () => {
  it('builds every feature of a 12-feature plan after one Go, past the usual step limit', async () => {
    const r = await run(true)
    expect(r.built).toEqual(script().flatMap((s) => (s.calls ?? []).filter((c) => c.name === 'geom.extrude').map((c) => (c.args as { name: string }).name)))
    expect(r.done).toMatchObject({ stopReason: 'end' })
  })

  it('a plan that was not approved keeps the usual limits', async () => {
    const r = await run(false)
    expect(r.built.length).toBeLessThan(FEATURES.length)
    expect(r.done).toMatchObject({ stopReason: 'max_steps' })
  })
})

describe('"keep going" after a run cut off at its step limit', () => {
  const extrude = (log: string[]) =>
    defineTool<{ name: string; operation?: string | undefined }>({
      name: 'geom.extrude',
      version: '1',
      description: 'One feature',
      source: 'command',
      permission: 'read',
      input: z.object({ name: z.string(), operation: z.string().optional() }),
      async run(i) {
        log.push(i.name)
        return { summary: `Built ${i.name}` }
      },
    })
  const SHEET = { name: 'pilot.sheet', args: { title: 'Case sizes', dims: [{ key: 'length', label: 'Length', value: 96, unit: 'mm', source: 'guess' }] } }

  it('keeps the confirmed sheet, so the rest of the part needs no second sheet', async () => {
    const log: string[] = []
    const steps: ScriptStep[] = [
      { calls: [SHEET] },
      { calls: [{ name: 'geom.extrude', args: { name: 'Base' } }] },
      { calls: [{ name: 'geom.extrude', args: { name: 'Base hollow', operation: 'cut' } }] },
      // the limit: the scripted client answers the runtime's wrap note itself
      // the next message, "keep going": the lid is a new body
      { calls: [{ name: 'geom.extrude', args: { name: 'Lid' } }] },
      { text: 'The lid is built beside the base.' },
    ]
    const { sheetTool } = await import('../src/index')
    const p = createPilot({ host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never, config: { ...DEFAULT_CONFIG, maxSteps: 3, maxToolCalls: 10 }, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), extrude(log)] as never[] })
    const ends: unknown[] = []
    for (const message of ['A Pi 5 case with a lid', 'keep going']) {
      for await (const e of p.run('s', message)) {
        if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
        if (e.type === 'done') ends.push(e.stopReason)
      }
    }
    expect(ends).toEqual(['max_steps', 'end'])
    expect(log).toEqual(['Base', 'Base hollow', 'Lid'])
  })
})

// The tab sends two calls on many steps (a sketch and its feature, a feature and its sheet tie), so a plan's Go raises
// the tool call limit with the step limit, and a run that still stops at the call limit keeps the sheet like one that
// stops at the step limit.
describe('the tool call limit', () => {
  it('a Go on a plan raises the call limit too, so a plan that needs more calls than the run had is built', async () => {
    const t = tools(true)
    const steps: ScriptStepData[] = [{ calls: [{ name: 'design.plan', args: { part: 'Pi 5 case', features: FEATURES.map((name) => ({ name })) } }] }]
    // three steps of two calls each per feature: 36 steps fit the plan's step room, 72 calls only a raised call limit
    for (const name of FEATURES) for (const k of [1, 2, 3]) steps.push({ calls: [{ name: 'geom.extrude', args: { name: `${name} sketch ${k}` } }, { name: 'geom.extrude', args: { name: `${name} ${k}` } }] })
    steps.push({ text: 'Built.' })
    const pilot = createPilot({ host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never, config: { ...DEFAULT_CONFIG, maxSteps: 10, maxToolCalls: 8 }, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: t.list as never[] })
    const events: PilotEvent[] = []
    for await (const e of pilot.run('s', 'A Pi 5 case')) events.push(e)
    expect(t.built).toHaveLength(FEATURES.length * 6)
    expect(events.find((e) => e.type === 'done')).toMatchObject({ stopReason: 'end' })
  })
})

describe('a sheet kept after a cut-off run', () => {
  const extrude = (log: string[]) =>
    defineTool<{ name: string; operation?: string | undefined; design?: string | undefined }>({
      name: 'geom.extrude',
      version: '1',
      description: 'One feature',
      source: 'command',
      permission: 'read',
      input: z.object({ name: z.string(), operation: z.string().optional(), design: z.string().optional() }),
      async run(i) {
        log.push(i.name)
        return { summary: `Built ${i.name}` }
      },
    })
  const SHEET = { name: 'pilot.sheet', args: { title: 'Case sizes', dims: [{ key: 'length', label: 'Length', value: 96, unit: 'mm', source: 'guess' }] } }
  const x = (name: string, design: string, operation?: string) => ({ calls: [{ name: 'geom.extrude', args: { name, design, ...(operation ? { operation } : {}) } }] })

  async function chat(steps: ScriptStep[], messages: string[], limits: { maxSteps: number; maxToolCalls: number }) {
    const log: string[] = []
    const { sheetTool } = await import('../src/index')
    const client = createScriptedClient(steps, { chunk: false })
    const p = createPilot({ host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never, config: { ...DEFAULT_CONFIG, ...limits }, policy: DEFAULT_POLICY, client, builtins: false, tools: [sheetTool(), extrude(log)] as never[] })
    const ends: unknown[] = []
    for (const message of messages) {
      for await (const e of p.run('s', message)) {
        if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, {})
        if (e.type === 'done') ends.push(e.stopReason)
      }
    }
    const blocked = client.requests.flatMap((r) => r.messages).filter((m) => m.role === 'tool' && m.content.includes('"blocked":true')).length
    return { log, ends, blocked }
  }

  it('a run stopped at the tool call limit keeps the sheet for "keep going", like the step limit', async () => {
    const steps: ScriptStep[] = [{ calls: [SHEET] }, x('Base', 'd1'), x('Base hollow', 'd1', 'cut'), x('Vents', 'd1', 'cut'), x('Lid', 'd1'), { text: 'The lid is built.' }]
    const r = await chat(steps, ['A Pi 5 case with a lid', 'keep going'], { maxSteps: 20, maxToolCalls: 3 })
    expect(r.ends).toEqual(['denied', 'end'])
    expect(r.log).toEqual(['Base', 'Base hollow', 'Lid'])
    expect(r.blocked).toBe(0)
  })

  it('a different part after a cut-off run needs a sheet of its own', async () => {
    const steps: ScriptStep[] = [{ calls: [SHEET] }, x('Base', 'd1'), x('Base hollow', 'd1', 'cut'), x('Stand', 'd2'), { text: 'I need its sizes first.' }]
    const r = await chat(steps, ['A Pi 5 case with a lid', 'now a phone stand'], { maxSteps: 3, maxToolCalls: 10 })
    expect(r.ends[0]).toBe('max_steps')
    expect(r.log).toEqual(['Base', 'Base hollow'])
    expect(r.blocked).toBe(1)
  })

  it('the kept sheet lasts until a run finishes: the message after that needs a new sheet', async () => {
    const steps: ScriptStep[] = [{ calls: [SHEET] }, x('Base', 'd1'), x('Base hollow', 'd1', 'cut'), x('Lid', 'd1'), { text: 'Done.' }, x('Another lid', 'd1'), { text: 'I need the sizes again.' }]
    const r = await chat(steps, ['A Pi 5 case with a lid', 'keep going', 'one more lid'], { maxSteps: 3, maxToolCalls: 10 })
    expect(r.ends).toEqual(['max_steps', 'end', 'end'])
    expect(r.log).toEqual(['Base', 'Base hollow', 'Lid'])
    expect(r.blocked).toBe(1)
  })
})
