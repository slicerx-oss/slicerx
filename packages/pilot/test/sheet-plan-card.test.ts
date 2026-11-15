// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plan card approved at once at its default size (design.plan answers auto: it fits nothing the person has, so the
// card does not wait) has already shown the person the part's sizes, so a new part in the design started for that plan
// builds with no sheet first. A new part still waits for a sheet with no such plan, after a plan that waited, after a
// new part's sheet was canceled or set aside in words, and in a design that is not the plan's part. Edits to a built
// part need neither.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, sheetTool, type ScriptStep } from '../src/index'
import type { LlmMessage } from '../src/provider/types'
import { defineTool, type PilotTool, type ToolOutput } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

/** design.plan's answer when its card is approved at once, as the tab's plan tool gives it. */
const AUTO_SAID = 'Approved as shown at its default size (it fits nothing the person has, so the card does not wait): build it now, and give its size in the reply; the person changes it after'

/** What design.plan answers, call by call: approved at once (auto), approved on Go after waiting, or not approved. */
type PlanReply = 'auto' | 'waited' | 'declined'

function tools(ran: string[], plans: PlanReply[] = ['auto']): PilotTool<never>[] {
  let made = 0
  const designNew = defineTool({
    name: 'design.new',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ name: z.string() }),
    async run(i) {
      made++
      const design = `obj_${i.name.toLowerCase()}${made}`
      ran.push(`new ${design}`)
      return { summary: `Started ${i.name} (${design})`, output: { design, name: i.name, exact: false, steps: 0, volumeMm3: 0, parts: [] } }
    },
  }) as PilotTool<never>
  const plan = defineTool({
    name: 'design.plan',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ part: z.string() }).passthrough(),
    async run(i, ctx): Promise<ToolOutput> {
      const reply = plans.shift() ?? 'auto'
      const planId = `plan_${ran.length}`
      if (reply === 'declined') return { ok: false, summary: 'Not approved; build nothing until the plan is agreed', output: { planId, accepted: false } }
      if (reply === 'waited') {
        // the card waits for the person, who presses Go
        const picked = await ctx.ask!({ title: 'Plan', question: `Build ${i.part} from this plan?`, choices: [{ id: `go:${planId}`, label: 'Go' }, { id: `change:${planId}`, label: 'Not yet' }] })
        if (!picked.id.startsWith('go:')) return { ok: false, summary: 'Not approved', output: { planId, accepted: false } }
        return { summary: 'Approved as shown', output: { planId, accepted: true } }
      }
      return { summary: AUTO_SAID, output: { planId, accepted: true, auto: true } }
    },
  }) as PilotTool<never>
  const geom = (name: string) =>
    defineTool({
      name,
      version: '1.0.0',
      source: 'command',
      // a step that changes a design, so the run marks its part as having a body
      permission: 'slice',
      description: 'test',
      input: z.object({ design: z.string().optional(), operation: z.enum(['new', 'join', 'cut']).optional(), part: z.number().optional() }).passthrough(),
      async run(i) {
        ran.push(`${name} ${i.design ?? '-'} ${i.operation ?? 'new'}`)
        return { summary: 'ok', output: i.design ? { design: i.design } : {} }
      },
    }) as PilotTool<never>
  const lookup = defineTool({
    name: 'design.lookup_sizes',
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: 'test',
    input: z.object({ subject: z.string(), sizes: z.array(z.string()) }),
    async run() {
      return { summary: 'lookup_1: found 4 of 5 sizes; no source gave Total length', output: { lookupId: 'lookup_1' } }
    },
  }) as PilotTool<never>
  return [sheetTool(), designNew, plan, geom('geom.build'), geom('geom.extrude'), geom('geom.loft'), lookup]
}

/** The tool messages the model was sent, in order, read by a last step that ends the reply. */
function ending(seen: string[], text = 'Done.'): ScriptStep {
  return (m: LlmMessage[]) => {
    seen.push(...m.filter((x) => x.role === 'tool').map((x) => String(x.content)))
    return { text }
  }
}

const refusals = (seen: string[]) => seen.filter((s) => s.includes('"blocked":true'))

async function play(steps: ScriptStep[], o: { plans?: PlanReply[]; messages?: string[]; sheet?: (e: PilotEvent & { type: 'sheet' }) => [Record<string, number> | null, string?] } = {}) {
  const ran: string[] = []
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: tools(ran, o.plans) })
  const events: PilotEvent[] = []
  for (const message of o.messages ?? ['A block']) {
    for await (const e of p.run('s', message)) {
      events.push(e)
      if (e.type === 'sheet') {
        const [given, said] = o.sheet?.(e) ?? [{}]
        void p.answerSheet!(e.sheet.id, given, said)
      }
      if (e.type === 'ask') void p.answer!(e.askId, e.choices[0]!.id)
    }
  }
  return { ran, events }
}

const NEW = (name: string) => ({ name: 'design.new', args: { name } })
const PLAN = (part: string) => ({ name: 'design.plan', args: { part, units: 'mm', overall: { x: 40, y: 30, z: 20 }, features: [{ name: 'Body', kind: 'extrude', sizes: { length: 40 } }] } })
const BUILD = (design: string) => ({ name: 'geom.build', args: { design, solids: [{ type: 'box', min: [0, 0, 0], max: [40, 30, 20] }] } })
const ROW = { key: 'w', label: 'Width', value: 40, unit: 'mm', source: 'guess' }
const SHEET = { name: 'pilot.sheet', args: { title: 'Block', dims: [ROW] } }

/** The exact words the model reads when a new part is refused for its sheet. */
const SHEET_FIRST_WORDS =
  "Nothing was built. Before a new part, show its sizes with pilot.sheet, then send the same call again with the sheet's values. The sheet waits for the person only when it has fits or they asked to see the sizes; any other sheet shows and you build at once. A size the person gave in the request goes on the sheet as asked, and a looked-up size names its source with sourceTitle or sourceUrl."

describe('a plan card approved at once stands for the sheet', () => {
  it('lets the first body of the plan\'s part through with no refusal and no sheet', async () => {
    const seen: string[] = []
    const { ran, events } = await play([{ calls: [NEW('Block')] }, { calls: [PLAN('Block')] }, { calls: [BUILD('obj_block1')] }, ending(seen)])
    expect(ran).toEqual(['new obj_block1', 'geom.build obj_block1 new'])
    expect(refusals(seen)).toEqual([])
    expect(events.some((e) => e.type === 'sheet')).toBe(false)
  })

  it('holds for the first design started after the plan, named as its part, and every new body in it that run', async () => {
    const seen: string[] = []
    const loft = { name: 'geom.loft', args: { design: 'obj_box1', operation: 'new' } }
    const { ran } = await play([{ calls: [PLAN('Box')] }, { calls: [NEW('Box')] }, { calls: [loft] }, { calls: [{ name: 'geom.extrude', args: { operation: 'new' } }] }, ending(seen)])
    expect(ran).toEqual(['new obj_box1', 'geom.loft obj_box1 new', 'geom.extrude - new'])
    expect(refusals(seen)).toEqual([])
  })

  it('(a) still refuses a new part with no accepted plan and no confirmed sheet', async () => {
    const seen: string[] = []
    const { ran } = await play([{ calls: [NEW('Block')] }, { calls: [BUILD('obj_block1')] }, ending(seen)])
    expect(ran).toEqual(['new obj_block1'])
    expect(refusals(seen)).toHaveLength(1)
    // a plan the person turned down stands for nothing either
    const declined: string[] = []
    const after = await play([{ calls: [NEW('Block')] }, { calls: [PLAN('Block')] }, { calls: [BUILD('obj_block1')] }, ending(declined)], { plans: ['declined'] })
    expect(after.ran).toEqual(['new obj_block1'])
    expect(refusals(declined)).toHaveLength(1)
  })

  // The card waited for the person and they pressed Go: an approved plan never confirmed a sheet before this change,
  // and a waiting one still does not, so the part's sizes go on a sheet first.
  it('(b) still refuses after a plan whose card waited, even once the person approved it', async () => {
    const seen: string[] = []
    const { ran, events } = await play([{ calls: [NEW('Block')] }, { calls: [PLAN('Block')] }, { calls: [BUILD('obj_block1')] }, ending(seen)], { plans: ['waited'] })
    expect(events.some((e) => e.type === 'ask_answered' && !('auto' in e))).toBe(true)
    expect(ran).toEqual(['new obj_block1'])
    expect(refusals(seen)).toHaveLength(1)
  })

  it('(b) still refuses when the person asked to see the sizes, since that sheet waits for them', async () => {
    const seen: string[] = []
    const { ran } = await play([{ calls: [NEW('Block')] }, { calls: [PLAN('Block')] }, { calls: [BUILD('obj_block1')] }, ending(seen)], { messages: ['A block, show me the sizes first'] })
    expect(ran).toEqual(['new obj_block1'])
    expect(refusals(seen)).toHaveLength(1)
  })

  // A sheet waits to be canceled only when the person asked to see the sizes, which holds a plan card back in that turn
  // anyway; so the sheet is turned down in one message and the plan comes in the next, where nothing else holds it.
  const turnedDown: ScriptStep[] = [{ calls: [SHEET] }, { text: 'What should change?' }, { calls: [NEW('Block')] }, { calls: [PLAN('Block')] }]
  it('(c) still refuses after a new part\'s sheet was canceled', async () => {
    const seen: string[] = []
    const { ran } = await play([...turnedDown, { calls: [BUILD('obj_block1')] }, ending(seen)], { messages: ['Show me the sizes of a block', 'Build the block'], sheet: () => [null] })
    expect(ran).toEqual(['new obj_block1'])
    expect(refusals(seen)).toHaveLength(1)
  })

  it('(c) still refuses after a new part\'s sheet was set aside in words', async () => {
    const seen: string[] = []
    const { ran } = await play([...turnedDown, { calls: [BUILD('obj_block1')] }, ending(seen)], { messages: ['Show me the sizes of a block', 'Build the block'], sheet: () => [null, 'make it taller'] })
    expect(ran).toEqual(['new obj_block1'])
    expect(refusals(seen)).toHaveLength(1)
  })

  it('(d) still refuses a new part in a design that is not the plan\'s part', async () => {
    // a stand started before a plan for a block: the plan is not the stand's
    const seen: string[] = []
    const { ran } = await play([{ calls: [NEW('Stand')] }, { calls: [PLAN('Block')] }, { calls: [BUILD('obj_stand1')] }, ending(seen)])
    expect(ran).toEqual(['new obj_stand1'])
    expect(refusals(seen)).toHaveLength(1)
    // the block builds from its plan, then a stand started after it needs its own sizes shown
    const later: string[] = []
    const two = await play([{ calls: [PLAN('Block')] }, { calls: [NEW('Block')] }, { calls: [BUILD('obj_block1')] }, { calls: [NEW('Stand')] }, { calls: [BUILD('obj_stand2')] }, ending(later)])
    expect(two.ran).toEqual(['new obj_block1', 'geom.build obj_block1 new', 'new obj_stand2'])
    expect(refusals(later)).toHaveLength(1)
  })

  it('(e) lets an edit to a built part through with no plan and no sheet', async () => {
    const seen: string[] = []
    const { ran } = await play([{ calls: [{ name: 'geom.extrude', args: { design: 'obj_box', operation: 'cut', part: 0 } }] }, ending(seen)])
    expect(ran).toEqual(['geom.extrude obj_box cut'])
    expect(refusals(seen)).toEqual([])
  })

  // The shape every refused session had: the sizes looked up and the design started in one step, the plan approved at
  // once with its overall size, then the part's first body with no sheet. Literal values from one such chain, with the
  // part renamed.
  it('replays the recorded chain with no refusal', async () => {
    const seen: string[] = []
    const steps: ScriptStep[] = [
      {
        calls: [
          { name: 'design.lookup_sizes', args: { subject: 'Stand', sizes: ['Total length', 'Main span length', 'Tower height above water', 'Deck width', 'Main cable diameter'] } },
          NEW('Stand'),
        ],
      },
      {
        calls: [
          {
            name: 'design.plan',
            args: {
              part: 'Stand',
              units: 'mm',
              detail: 'display',
              scale: '6000',
              personSize: false,
              flat: ['Base'],
              tiers: { Base: ['Base'] },
              curved: ['Main cable'],
              repeats: ['Hanger'],
              overall: { x: 213, y: 4.6, z: 38 },
              features: [
                { name: 'Base', kind: 'extrude', sizes: { length: 213, width: 4.6, height: 1 } },
                { name: 'Base rails', kind: 'extrude', on: 'Base', sizes: { length: 213, width: 4.6, height: 0.6 } },
                { name: 'South post', kind: 'extrude', on: 'Base', sizes: { height: 38, width: 3, depth: 1.2 } },
                { name: 'North post', kind: 'extrude', on: 'Base', sizes: { height: 38, width: 3, depth: 1.2 } },
                { name: 'Main cable', kind: 'loft', sizes: { diameter: 0.15, sag: 4, sections: 6 } },
              ],
              assumptions: [],
              questions: [],
            },
          },
        ],
      },
      { calls: [{ name: 'geom.build', args: { design: 'obj_stand1', name: 'Stand', feature: 'Base', solids: [{ type: 'box', min: [0, 0, 0], max: [213, 4.6, 1] }] } }] },
      ending(seen, 'Built the stand, 213 mm long.'),
    ]
    const { ran, events } = await play(steps, { messages: ['Make me a stand'] })
    expect(seen.some((s) => s.includes(AUTO_SAID) && s.includes('"auto":true'))).toBe(true)
    expect(ran).toEqual(['new obj_stand1', 'geom.build obj_stand1 new'])
    expect(refusals(seen)).toHaveLength(0)
    expect(events.some((e) => e.type === 'sheet')).toBe(false)
  })
})

describe('the words the model reads', () => {
  it('gets the sheet-first refusal in its new words', async () => {
    const seen: string[] = []
    await play([{ calls: [NEW('Block')] }, { calls: [BUILD('obj_block1')] }, ending(seen)])
    const [refused] = refusals(seen)
    expect(JSON.parse(refused!)).toEqual({ ok: false, blocked: true, message: SHEET_FIRST_WORDS })
  })

  it('gets the sheet\'s refusal of a looked-up size with no source in its new words', async () => {
    const seen: string[] = []
    const lookedUp = { name: 'pilot.sheet', args: { title: 'Block', dims: [{ key: 'l', label: 'Length', value: 215, unit: 'mm', source: 'lookup' }] } }
    await play([{ calls: [lookedUp] }, ending(seen)])
    const reply = JSON.parse(seen[0]!) as { ok: boolean; issues: string[] }
    expect(reply.ok).toBe(false)
    expect(reply.issues).toContain('(input): a looked-up value names where it came from: its sourceTitle, its sourceUrl, or a note such as "269 m real at 1:1250"')
  })
})
