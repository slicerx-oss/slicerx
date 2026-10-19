// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Where pilot.sheet is offered, a new part waits for a confirmed sheet: geom.extrude, geom.revolve (as a new body) and
// geom.build are refused until the person confirms the sizes in the same run. Edits to a part, a canceled sheet and a
// toolset without the sheet behave as before. A confirmed sheet no part has used yet carries over to the chat's next
// run, so a plan answered in a later message needs no second sheet.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '../src/index'
import { SHEET_FIRST_NOTE, startsPart } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

function geom(name: string, ran: string[]): PilotTool<never> {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ operation: z.enum(['new', 'join', 'cut']).optional(), part: z.number().optional() }),
    async run(i) {
      ran.push(`${name}:${i.operation ?? 'new'}`)
      return { summary: 'ok' }
    },
  }) as PilotTool<never>
}

const SHEET = { name: 'pilot.sheet', args: { title: 'Box', dims: [{ key: 'w', label: 'Width', value: 40, unit: 'mm', source: 'asked' }] } }
const EXTRUDE = { name: 'geom.extrude', args: {} }

async function play(steps: ScriptStep[], opts: { sheet?: boolean; answer?: Record<string, number> | null; runs?: number } = {}) {
  const ran: string[] = []
  const tools = [...(opts.sheet === false ? [] : [sheetTool()]), geom('geom.extrude', ran), geom('geom.build', ran)]
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools })
  const events: PilotEvent[] = []
  for (let r = 0; r < (opts.runs ?? 1); r++) {
    for await (const e of p.run('s', 'A box')) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, opts.answer === undefined ? {} : opts.answer)
    }
  }
  return { ran, events }
}

const toolReplies = (events: PilotEvent[]) => events.filter((e) => e.type === 'tool_result')

describe('a sheet before the first build', () => {
  it('tells which calls start a part', () => {
    expect(startsPart('geom.build', {})).toBe(true)
    expect(startsPart('geom.extrude', {})).toBe(true)
    expect(startsPart('geom.revolve', { operation: 'new' })).toBe(true)
    expect(startsPart('geom.extrude', { operation: 'cut', part: 0 })).toBe(false)
    expect(startsPart('geom.fillet', {})).toBe(false)
  })

  it('refuses a new part with no confirmed sheet and says to show one', async () => {
    const seen: string[] = []
    const { ran } = await play([{ calls: [EXTRUDE] }, (m) => (seen.push(m.at(-1)?.content ?? ''), { text: 'Showing the sizes first.' })])
    expect(ran).toEqual([])
    expect(seen[0]).toContain(SHEET_FIRST_NOTE)
  })

  it('builds once the sheet is confirmed, then keeps building in that run', async () => {
    const { ran } = await play([{ calls: [SHEET] }, { calls: [EXTRUDE] }, { calls: [{ name: 'geom.build', args: {} }] }, { text: 'Built.' }])
    expect(ran).toEqual(['geom.extrude:new', 'geom.build:new'])
  })

  it('still refuses after a canceled sheet', async () => {
    const { ran } = await play([{ calls: [SHEET] }, { calls: [EXTRUDE] }, { text: 'Nothing built.' }], { answer: null })
    expect(ran).toEqual([])
  })

  it('lets edits to a part through without a sheet', async () => {
    const { ran } = await play([{ calls: [{ name: 'geom.extrude', args: { operation: 'cut', part: 0 } }] }, { text: 'Cut.' }])
    expect(ran).toEqual(['geom.extrude:cut'])
  })

  it('asks again for a new part in a later run', async () => {
    const { ran } = await play([{ calls: [SHEET] }, { calls: [EXTRUDE] }, { text: 'Built.' }, { calls: [EXTRUDE] }, { text: 'Need sizes.' }], { runs: 2 })
    expect(ran).toEqual(['geom.extrude:new'])
  })

  it('does not gate a toolset without pilot.sheet', async () => {
    const { ran, events } = await play([{ calls: [EXTRUDE] }, { text: 'Built.' }], { sheet: false })
    expect(ran).toEqual(['geom.extrude:new'])
    expect(toolReplies(events).every((e) => e.type === 'tool_result' && e.ok)).toBe(true)
  })

  it('keeps a confirmed sheet for a plan answered in a later message, then asks again after the part', async () => {
    const ran: string[] = []
    // a stand-in for the tab's design.plan: a card answered on the question channel
    const plan = defineTool({
      name: 'design.plan',
      version: '1.0.0',
      source: 'command',
      permission: 'read',
      description: 'test',
      input: z.object({}),
      async run(_i, ctx) {
        const picked = await ctx.ask!({ title: 'Plan', question: 'Build from this plan?', choices: [{ id: 'go', label: 'Go' }, { id: 'change', label: 'Not yet' }] })
        return picked === 'go' ? { summary: 'Approved' } : { ok: false, summary: 'Not approved' }
      },
    }) as PilotTool<never>
    const PLAN = { name: 'design.plan', args: {} }
    const steps: ScriptStep[] = [
      // run 1: the sheet is confirmed, the plan is not approved yet
      { calls: [SHEET] },
      { calls: [PLAN] },
      { text: 'What should change?' },
      // run 2: the person answers in a new message; the plan is approved and the part builds with no second sheet
      { calls: [PLAN] },
      { calls: [EXTRUDE] },
      { text: 'Built.' },
      // run 3: a new part needs its own sheet
      { calls: [EXTRUDE] },
      { text: 'Sizes first.' },
    ]
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), plan, geom('geom.extrude', ran)] })
    const answers = ['change', 'go']
    const sheets: string[] = []
    const blocked: string[] = []
    for (const message of ['A bracket with two holes', 'Make the holes 5 mm and go', 'Now a lid']) {
      for await (const e of p.run('s', message)) {
        if (e.type === 'sheet') (sheets.push(e.sheet.id), void p.answerSheet!(e.sheet.id, {}))
        if (e.type === 'ask') void p.answer!(e.askId, answers.shift()!)
      }
      blocked.push(ran.join(','))
    }
    expect(sheets).toHaveLength(1)
    expect(ran).toEqual(['geom.extrude:new'])
    // the extrude ran in run 2, and run 3's was refused
    expect(blocked).toEqual(['', 'geom.extrude:new', 'geom.extrude:new'])
  })

  it('drops a confirmation when a later sheet is canceled', async () => {
    const ran: string[] = []
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ calls: [SHEET] }, { text: 'Ok.' }, { calls: [SHEET] }, { calls: [EXTRUDE] }, { text: 'No sizes.' }], { chunk: false }), builtins: false, tools: [sheetTool(), geom('geom.extrude', ran)] })
    const answers: (Record<string, number> | null)[] = [{}, null]
    for (const message of ['A box', 'Changed my mind']) {
      for await (const e of p.run('s', message)) if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, answers.shift()!)
    }
    expect(ran).toEqual([])
  })
})
