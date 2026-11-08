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
