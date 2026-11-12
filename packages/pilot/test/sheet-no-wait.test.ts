// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A sheet waits for the person only when a size must fit something they have or the part holds (fits), or for pieces
// that print assembled and move. Any other sheet shows its sizes and the build goes on with them at once, marked as
// nobody asked. In a follow-up on a part already built no sheet waits, and a build into that part is no new part. A
// question card can be answered at once the same way, and a plan waits only after a sheet with fits.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '../src/index'
import { SHEET_FIRST_NOTE } from '../src/runtime'
import { asksSheet } from '../src/sheet-ask'
import { defineTool, type PilotTool, type ToolContext } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const ROW = { key: 'w', label: 'Width', value: 40, unit: 'mm', source: 'guess' }
const sheet = (fits?: boolean) => ({ name: 'pilot.sheet', args: { title: 'Planter', ...(fits ? { fits } : {}), dims: [ROW] } })

function setup(steps: ScriptStep[]) {
  const ran: string[] = []
  let confirms: boolean | undefined
  const build = defineTool({
    name: 'geom.build',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'test',
    input: z.object({ design: z.string().optional() }),
    async run(i, ctx: ToolContext) {
      ran.push(`build ${i.design ?? 'new'}`)
      confirms = ctx.confirmsPlan?.()
      return { summary: 'Built', output: { design: i.design ?? 'd1' } }
    },
  }) as PilotTool<never>
  const look = defineTool({
    name: 'design.look',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ design: z.string(), compare: z.boolean().optional() }),
    async run(i) {
      ran.push(i.compare ? 'compare' : 'look')
      return { summary: 'Looked', output: i.compare ? { visiblePct: 5, floorPct: 2 } : { design: i.design } }
    },
  }) as PilotTool<never>
  const check = defineTool({
    name: 'design.check',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ planId: z.string() }),
    async run() {
      return { summary: 'All checks pass', output: { design: 'd1', nozzleMm: 0.4, pass: true } }
    },
  }) as PilotTool<never>
  const choose = defineTool({
    name: 'test.choose',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({}),
    async run(_i, ctx: ToolContext) {
      const picked = await ctx.ask!({ title: 'Pick', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, { auto: 'b' })
      return { summary: `Picked ${picked.id}` }
    },
  }) as PilotTool<never>
  const p = createPilot({ host, config: { ...DEFAULT_CONFIG, maxSteps: 20 }, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), build, look, check, choose] })
  // only a sheet that waits is answered: one shown with nobody asked has no answer to take
  const say = async (message: string, answer = false) => {
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) {
      events.push(e)
      if (e.type === 'sheet' && answer) void p.answerSheet!(e.sheet.id, {})
    }
    return events
  }
  return { ran, say, confirms: () => confirms }
}

const results = (events: PilotEvent[]) => events.flatMap((e) => (e.type === 'tool_result' ? [e.summary ?? ''] : []))

describe('a sheet that fits nothing the person has', () => {
  it('shows and goes ahead with its sizes at once, nobody asked, and the build after it is not held', async () => {
    const { ran, say, confirms } = setup([{ calls: [sheet()] }, { calls: [{ name: 'geom.build', args: {} }] }, { text: 'Built a 40 mm planter.' }])
    const events = await say('make a planter')
    const answered = events.find((e) => e.type === 'sheet_answered')
    expect(answered).toMatchObject({ auto: true, answer: { confirmed: true, values: { w: 40 }, auto: true } })
    expect(results(events)[0]).toMatch(/^Shown; build with these sizes now/)
    expect(ran).toEqual(['build new'])
    // no sheet with fits: a plan at its default size goes straight through
    expect(confirms()).toBe(false)
  })

  it('waits for the person when a size must fit something, and a plan then waits for its Go', async () => {
    const { ran, say, confirms } = setup([{ calls: [sheet(true)] }, { calls: [{ name: 'geom.build', args: {} }] }, { text: 'Built.' }])
    const events = await say('make a planter for my 40 mm pot', true)
    expect(events.find((e) => e.type === 'sheet_answered')).not.toHaveProperty('auto')
    expect(results(events)[0]).toBe('Confirmed as shown')
    expect(ran).toEqual(['build new'])
    expect(confirms()).toBe(true)
  })

  it('waits for the person on a sheet they asked to see, with no fits, so its drawing stays up to read and edit', async () => {
    const { ran, say } = setup([{ calls: [{ name: 'geom.build', args: {} }] }, { calls: [{ name: 'pilot.sheet', args: { title: 'Box', design: 'd1', dims: [ROW] } }] }, { text: 'Here are its sizes.' }])
    const events: PilotEvent[] = await say('show me the sheet of the box', true)
    const shown = events.find((e) => e.type === 'sheet')
    expect(shown).toMatchObject({ sheet: { design: 'd1' } })
    const answered = events.find((e) => e.type === 'sheet_answered')
    expect(answered).not.toHaveProperty('auto')
    expect(answered).toMatchObject({ answer: { confirmed: true } })
    expect(answered).not.toHaveProperty('answer.auto')
    expect(results(events)).toContain('Confirmed as shown')
    expect(ran).toEqual([])
  })

  it('still holds a new part with no sheet at all', async () => {
    const { ran, say } = setup([{ calls: [{ name: 'geom.build', args: {} }] }, { text: 'Done.' }])
    const events = await say('make a planter')
    expect(ran).toEqual([])
    expect(JSON.stringify(events)).not.toContain('Built')
    expect(SHEET_FIRST_NOTE).toContain('Nothing was built')
  })
})

describe('a follow-up on a part already built', () => {
  const built: ScriptStep[] = [{ calls: [sheet()] }, { calls: [{ name: 'geom.build', args: {} }] }, { calls: [{ name: 'design.check', args: { planId: 'p1' } }] }, { text: 'Built.' }]

  it('adds a body to that part with no sheet, and a plain sheet it shows does not wait', async () => {
    const { ran, say } = setup([...built, { calls: [{ name: 'geom.build', args: { design: 'd1' } }] }, { calls: [sheet()] }, { text: 'Added a rim.' }])
    await say('make a planter')
    ran.length = 0
    const events = await say('add a rim')
    expect(ran).toEqual(['look', 'build d1', 'compare'])
    expect(events.filter((e) => e.type === 'sheet_answered')).toEqual([expect.objectContaining({ auto: true })])
  })

  it('waits on a sheet the person asked to see, with the built design on it', async () => {
    const { say } = setup([...built, { calls: [{ name: 'pilot.sheet', args: { title: 'Planter', design: 'd1', dims: [ROW] } }] }, { text: 'Here are its sizes.' }])
    await say('make a planter')
    const events = await say('show me the dimension sheet', true)
    expect(events.find((e) => e.type === 'sheet')).toMatchObject({ sheet: { design: 'd1' } })
    const answered = events.filter((e) => e.type === 'sheet_answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]).not.toHaveProperty('auto')
    expect(results(events)).toContain('Confirmed as shown')
  })

  it('goes ahead on a resize that shows a sheet with the built design on it', async () => {
    const { say } = setup([...built, { calls: [{ name: 'pilot.sheet', args: { title: 'Planter', design: 'd1', dims: [{ ...ROW, value: 60 }] } }] }, { text: 'Resized.' }])
    await say('make a planter')
    const events = await say('make it 60 mm wide')
    expect(events.find((e) => e.type === 'sheet')).toMatchObject({ sheet: { design: 'd1' } })
    expect(events.filter((e) => e.type === 'sheet_answered')).toEqual([expect.objectContaining({ auto: true })])
  })

  it('waits on a sheet whose sizes must fit something', async () => {
    const { say } = setup([...built, { calls: [{ name: 'geom.build', args: { design: 'd1' } }] }, { calls: [sheet(true)] }, { text: 'Added a rim.' }])
    await say('make a planter')
    const events = await say('add a rim that fits my 40 mm saucer', true)
    const answered = events.filter((e) => e.type === 'sheet_answered')
    expect(answered).toHaveLength(1)
    expect(answered[0]).not.toHaveProperty('auto')
  })

  it('still holds a new part started in another design', async () => {
    const { ran, say } = setup([...built, { calls: [{ name: 'geom.build', args: { design: 'd2' } }] }, { text: 'Done.' }])
    await say('make a planter')
    ran.length = 0
    await say('and a saucer')
    expect(ran).toEqual(['look'])
  })
})

describe('a question answered at once', () => {
  it('shows the card with the answer it went ahead with, marked as nobody asked', async () => {
    const { say } = setup([{ calls: [{ name: 'test.choose', args: {} }] }, { text: 'OK.' }])
    const events = await say('pick')
    const ask = events.find((e) => e.type === 'ask')
    const answered = events.find((e) => e.type === 'ask_answered')
    expect(ask).toBeDefined()
    expect(answered).toMatchObject({ choiceId: 'b', auto: true })
    expect(results(events)).toContain('Picked b')
  })
})

describe('asksSheet reads an ask to see the sheet from the words', () => {
  it('takes an ask to see the sheet, the sizes or the drawing', () => {
    for (const m of ['show me the dimension sheet', "Show me the dimension sheet for the box's main sizes", 'Main sizes of the print, please', 'What are the main sizes of my stand design?', 'let me see the drawing', 'show me the sizes, then make it wider'])
      expect(asksSheet(m), m).toBe(true)
  })

  it('takes no change, a new part or a resize as one', () => {
    for (const m of ['make it 60 mm wide', 'add a rim', 'make the lid 2 mm thicker', 'change the sizes to fit my phone', 'make a planter', 'and a saucer'])
      expect(asksSheet(m), m).toBe(false)
  })
})
