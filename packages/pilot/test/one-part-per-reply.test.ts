// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A reply fixes the part it started instead of starting it again. A second design.new in the same run is a restart, and
// refused with the part to fix and how (design.undo), when the part started last has no body yet or its last step did
// not go through, or when the new name, without version words (v2, 2, new, again, fixed...), is a started part's name or
// holds every word of it ("Cable clip 3 mm" after "Cable clip"). Anything else starts its own design: a box and a saucer,
// two brackets, a left and a right bracket, two parts asked for in any language. The person's message and the plan are
// never read for it. The next message starts its own part as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, type LlmMessage, type ScriptStep } from '../src/index'
import { ONE_PART_NOTE, restartOf } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

function designNew(made: string[]): PilotTool<never> {
  return defineTool({
    name: 'design.new',
    version: '1.0.0',
    source: 'command',
    permission: 'slice',
    description: 'test',
    input: z.object({ name: z.string() }),
    async run(i) {
      const id = `obj_${made.length + 1}`
      made.push(i.name)
      return { summary: `Started ${i.name} (${id})`, output: { design: id, name: i.name } }
    },
  }) as PilotTool<never>
}

/** A feature step in a design: a new body unless it says otherwise, and one that does not go through when `fails`. */
const extrude = defineTool({
  name: 'geom.extrude',
  version: '1.0.0',
  source: 'command',
  permission: 'slice',
  description: 'test',
  input: z.object({ design: z.string(), name: z.string(), operation: z.string().optional(), fails: z.boolean().optional() }),
  async run(i) {
    if (i.fails) return { ok: false, summary: `${i.name} did not go through: the sketch is open` }
    return { summary: `Built ${i.name}`, output: { design: i.design } }
  },
}) as PilotTool<never>

/** A look at a design that changes nothing. */
const info = defineTool({
  name: 'geom.info',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'test',
  input: z.object({ design: z.string() }),
  async run(i) {
    return { summary: `${i.design}: no body yet`, output: { design: i.design } }
  },
}) as PilotTool<never>

const NEW = (name: string) => ({ calls: [{ name: 'design.new', args: { name } }] })
/** A body for `design`, or a step on it that does not go through. */
const BODY = (design: string, name = 'Body') => ({ calls: [{ name: 'geom.extrude', args: { design, name } }] })
const FAILED = (design: string, name = 'Body') => ({ calls: [{ name: 'geom.extrude', args: { design, name, fails: true } }] })

/** design.plan answered Go, as the plan card does. */
const plan = defineTool({
  name: 'design.plan',
  version: '1.0.0',
  source: 'command',
  permission: 'read',
  description: 'test',
  input: z.object({ part: z.string(), features: z.array(z.object({ name: z.string() })) }),
  async run() {
    return { summary: 'Approved as shown', output: { planId: 'plan_1', accepted: true } }
  },
}) as PilotTool<never>

async function reply(message: string, steps: ScriptStep[]): Promise<{ made: string[]; seen: string[] }> {
  const made: string[] = []
  const seen: string[] = []
  // each step after a call sees that call's answer last
  const watched = steps.map((s) => (m: LlmMessage[]) => (seen.push(m.at(-1)?.content ?? ''), typeof s === 'function' ? s(m) : s))
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(watched, { chunk: false }), builtins: false, tools: [designNew(made), extrude, info, plan] })
  for await (const _ of p.run('s', message)) void _
  return { made, seen }
}

describe('separate parts in one reply', () => {
  it('starts a box and then a saucer, once the box has a body', async () => {
    const { made } = await reply('A planter box and a saucer for it', [NEW('Planter box'), BODY('obj_1'), NEW('Saucer'), BODY('obj_2'), { text: 'Both built.' }])
    expect(made).toEqual(['Planter box', 'Saucer'])
  })

  it('starts two numbered brackets', async () => {
    const { made } = await reply('Two brackets for my shelf', [NEW('Bracket 1'), BODY('obj_1'), NEW('Bracket 2'), BODY('obj_2'), { text: 'Both built.' }])
    expect(made).toEqual(['Bracket 1', 'Bracket 2'])
  })

  it('starts a left and a right bracket', async () => {
    const { made } = await reply('A left and a right bracket', [NEW('Left bracket'), BODY('obj_1'), NEW('Right bracket'), BODY('obj_2'), { text: 'Both built.' }])
    expect(made).toEqual(['Left bracket', 'Right bracket'])
  })

  it('starts two parts asked for in a language without spaces between words', async () => {
    const { made } = await reply('植木鉢と受け皿を作って', [NEW('植木鉢'), BODY('obj_1'), NEW('受け皿'), BODY('obj_2'), { text: '両方できました。' }])
    expect(made).toEqual(['植木鉢', '受け皿'])
  })

  it('starts each part of an assembly once the one before has a body', async () => {
    const { made } = await reply('A small gearbox assembly: a housing, a drive gear and a cover', [NEW('Gearbox housing'), BODY('obj_1'), NEW('Drive gear'), BODY('obj_2'), NEW('Cover'), { text: 'All three started.' }])
    expect(made).toEqual(['Gearbox housing', 'Drive gear', 'Cover'])
  })

  it('starts a separate part after the step that failed was fixed', async () => {
    const { made } = await reply('A box and a lid as separate designs', [NEW('Box'), FAILED('obj_1'), BODY('obj_1'), NEW('Lid'), { text: 'Both started.' }])
    expect(made).toEqual(['Box', 'Lid'])
  })
})

describe('a restart in one reply', () => {
  it('refuses a second design.new, naming the part to fix, and starts one in the next message', async () => {
    const made: string[] = []
    const seen: string[] = []
    const steps: ScriptStep[] = [NEW('Headphone stand'), NEW('Headphone stand v2'), (m) => (seen.push(m.at(-1)?.content ?? ''), { text: 'Fixing the first one.' }), NEW('Desk clip'), { text: 'Started.' }]
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [designNew(made)] })
    for await (const _ of p.run('s', 'A headphone stand')) void _
    expect(made).toEqual(['Headphone stand'])
    expect(seen[0]).toContain(ONE_PART_NOTE('Headphone stand', 'obj_1', 'no_body'))
    expect(seen[0]).toMatch(/Fix the part you started: design\.undo takes back the last step that went through/)
    for await (const _ of p.run('s', 'Now a desk clip')) void _
    expect(made).toEqual(['Headphone stand', 'Desk clip'])
  })

  it('refuses a new part while the part started has no body, whatever the message names', async () => {
    const { made, seen } = await reply('A box and a lid as separate designs', [NEW('Box'), NEW('Lid'), { text: 'Building the box first.' }])
    expect(made).toEqual(['Box'])
    expect(seen[2]).toContain(ONE_PART_NOTE('Box', 'obj_1', 'no_body'))
  })

  it('refuses a restart after a failed extrude, under a name the message uses', async () => {
    const { made, seen } = await reply('A phone stand for my desk', [NEW('Phone stand'), FAILED('obj_1', 'Base'), NEW('Desk stand'), { text: 'Fixing the base.' }])
    expect(made).toEqual(['Phone stand'])
    expect(seen[3]).toContain(ONE_PART_NOTE('Phone stand', 'obj_1', 'failed'))
  })

  it('a look at the part does not clear a step that failed', async () => {
    const { made } = await reply('A phone stand for my desk', [NEW('Phone stand'), BODY('obj_1'), FAILED('obj_1', 'Slot'), { calls: [{ name: 'geom.info', args: { design: 'obj_1' } }] }, NEW('Desk stand'), { text: 'Fixing the slot.' }])
    expect(made).toEqual(['Phone stand'])
  })

  it('refuses "Cable clip 3 mm" after "Cable clip", even with a body and the size in the message', async () => {
    const { made, seen } = await reply('A cable clip for 3 mm cable', [NEW('Cable clip'), BODY('obj_1'), NEW('Cable clip 3 mm'), { text: 'Fixing the clip.' }])
    expect(made).toEqual(['Cable clip'])
    expect(seen[3]).toContain(ONE_PART_NOTE('Cable clip', 'obj_1', 'same_name'))
  })

  it('refuses a fuller name that holds the started one, with words from the message', async () => {
    const { made } = await reply('A Raspberry Pi 5 case', [NEW('Pi case'), BODY('obj_1'), NEW('Raspberry Pi case'), { text: 'Fixing the case.' }])
    expect(made).toEqual(['Pi case'])
  })

  it('refuses a restart named for a feature of the approved plan', async () => {
    const go = { calls: [{ name: 'design.plan', args: { part: 'Pi 5 case', features: [{ name: 'Base with standoffs' }, { name: 'Snap-fit lid' }] } }] }
    const { made } = await reply('A Raspberry Pi 5 case', [go, NEW('Pi 5 case'), BODY('obj_1'), NEW('Pi 5 case with standoffs'), { text: 'Fixing the case.' }])
    expect(made).toEqual(['Pi 5 case'])
  })

  it('refuses "Box v2" after "Box" even when the message names separate parts', async () => {
    const { made, seen } = await reply('A box and a lid as separate designs', [NEW('Box'), BODY('obj_1'), NEW('Box v2'), { text: 'Fixing the box.' }])
    expect(made).toEqual(['Box'])
    expect(seen[3]).toContain(ONE_PART_NOTE('Box', 'obj_1', 'same_name'))
  })

  it('names the part a restart repeats when the reply has started two', async () => {
    const { made, seen } = await reply('A box and a lid as separate designs', [NEW('Box'), BODY('obj_1'), NEW('Lid'), BODY('obj_2'), NEW('Lid v2'), { text: 'Fixing the lid.' }])
    expect(made).toEqual(['Box', 'Lid'])
    expect(seen[5]).toContain(ONE_PART_NOTE('Lid', 'obj_2', 'same_name'))
  })

  it('refuses a restart under a fuller name of the started part', async () => {
    const { made, seen } = await reply('A headphone stand', [NEW('Headphone stand'), BODY('obj_1'), NEW('Sturdier headphone stand'), { text: 'Fixing the stand.' }])
    expect(made).toEqual(['Headphone stand'])
    expect(seen[3]).toContain(ONE_PART_NOTE('Headphone stand', 'obj_1', 'same_name'))
  })
})

describe('restartOf, the name rule alone', () => {
  const started = (...names: string[]) => names.map((name, i) => ({ id: `obj_${i + 1}`, name }))
  it('matches a name that is a started one once version words are dropped', () => {
    for (const again of ['Box v2', 'New box', 'Box (fixed)', 'box again', 'Box retry', 'Improved box', 'BOX', 'Box 2']) expect(restartOf(again, started('Box'))?.name).toBe('Box')
  })
  it('matches a name holding every word of a started one', () => {
    expect(restartOf('Cable clip 3 mm', started('Cable clip'))?.name).toBe('Cable clip')
    expect(restartOf('Box with lid', started('Box'))?.name).toBe('Box')
  })
  it('lets other names through', () => {
    expect(restartOf('Saucer', started('Planter box'))).toBeUndefined()
    expect(restartOf('Right bracket', started('Left bracket'))).toBeUndefined()
    expect(restartOf('Bracket 2', started('Bracket 1'))).toBeUndefined()
    expect(restartOf('受け皿', started('植木鉢'))).toBeUndefined()
    expect(restartOf('Clip', started('Cable clip'))).toBeUndefined()
  })
})
