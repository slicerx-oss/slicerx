// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up keeps what it did not change: a run that would end with a built feature undone, turned off or built a
// second time beside the old one goes back to put it right before its reply, unless the person asked to remove it or
// the reply's first line names what is missing. An amount the person gave, or a small one they asked for, is never
// made larger by the measured-change note, and steps that only take something away are not measured as a change.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'
import { STRENGTHEN_NOTE } from '../src/runtime'
import { askedToRemove, keptAmountNote, lostFeatures, statesAmount, type KeptRow } from '../src/turn-keeps'

interface Built {
  id: string
  name: string
  op: string
  feature: string
  state: string
}

function setup(steps: ScriptStep[], shares: number[] = []) {
  const log: string[] = []
  let n = 0
  const built: Built[] = []
  const client = createScriptedClient(steps, { chunk: false })
  const tool = <T,>(name: string, permission: 'read' | 'slice', input: z.ZodType<T>, run: (i: T) => { summary: string; output: unknown; images?: { mime: 'image/png'; data: string }[] }) =>
    defineTool<T>({ name, version: '1', description: name, source: 'command', permission, input, async run(i) { return run(i) } })
  const extrude = tool('geom.extrude', 'slice', z.object({ design: z.string(), feature: z.string() }), (i) => {
    built.push({ id: `s${++n}`, name: `Extrude ${n}`, op: 'shape.extrude', feature: i.feature, state: 'done' })
    log.push(`extrude ${i.feature}`)
    return { summary: `Built ${i.feature}`, output: { design: i.design } }
  })
  const undo = tool('design.undo', 'slice', z.object({ design: z.string() }), (i) => {
    const gone = built.pop()
    log.push(`undo ${gone?.feature}`)
    return { summary: `Removed ${gone?.name}`, output: { design: i.design } }
  })
  const edit = tool('design.edit_step', 'slice', z.object({ design: z.string(), step: z.number(), suppressed: z.boolean().optional(), value: z.number().optional() }), (i) => {
    const s = built[i.step - 1]!
    if (i.suppressed !== undefined) s.state = i.suppressed ? 'suppressed' : 'done'
    log.push(`edit ${s.feature}`)
    return { summary: `Edited step ${i.step}`, output: { design: i.design } }
  })
  const list = tool('design.steps', 'read', z.object({ design: z.string() }), (i) => ({ summary: `${built.length} steps`, output: { design: i.design, steps: built.map((b, k) => ({ index: k + 1, ...b })) } }))
  const look = tool('design.look', 'read', z.object({ design: z.string(), compare: z.boolean().optional() }), (i) => {
    if (!i.compare) return { summary: 'Looked at the model', output: { design: i.design }, images: [{ mime: 'image/png', data: 'AAAA' }] }
    const pct = shares.shift() ?? 50
    log.push(`compare ${pct}`)
    return { summary: 'Looked at the model again', output: { design: i.design, visiblePct: pct, floorPct: 2, belowFloor: pct < 2 } }
  })
  const check = tool('design.check', 'read', z.object({ planId: z.string() }), () => ({ summary: 'All checks pass', output: { design: 'd1', nozzleMm: 0.4, pass: true } }))
  const p = createPilot({
    host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never,
    config: { ...DEFAULT_CONFIG, maxSteps: 30, maxToolCalls: 60 },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: [extrude, undo, edit, list, look, check] as never[],
  })
  const say = async (message: string) => {
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) events.push(e)
    return events
  }
  const notes = () => [...new Set((client.requests as { messages: { role: string; content: unknown }[] }[]).flatMap((r) => r.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string)))]
  return { log, built, say, notes }
}

const x = (feature: string) => ({ calls: [{ name: 'geom.extrude', args: { design: 'd1', feature } }] })
const undo = (k: number) => ({ calls: Array.from({ length: k }, () => ({ name: 'design.undo', args: { design: 'd1' } })) })
const FEATURES = ['Body', 'Lower tier', 'Upper tier', 'Stacks', 'Front pole']
// a first build of five features, checked against its plan: the next run on its design is a follow-up
const first: ScriptStep[] = [...FEATURES.map(x), { calls: [{ name: 'design.check', args: { planId: 'p1' } }] }, { text: 'Built it.' }]
const keepsNoteOf = (notes: string[]) => notes.find((n) => n.startsWith('Before you answer: this turn took away') || n.includes('beside step'))

describe('a follow-up keeps what it did not change', () => {
  it('sends a rollback to the base body back to build what it took away, and lets it end once rebuilt', async () => {
    const t = setup([...first, undo(4), { text: 'Rolled back to rebuild the tiers next time.' }, x('Lower tier'), x('Upper tier'), x('Stacks'), x('Front pole'), { text: 'The tiers are stepped, and the stacks and pole are back.' }])
    await t.say('make a model')
    t.log.length = 0
    const events = await t.say('step the upper blocks into tiers')
    const note = keepsNoteOf(t.notes())
    expect(note).toContain('took away Lower tier, Upper tier, Stacks, Front pole, which the person did not ask to remove')
    expect(t.built.map((b) => b.feature)).toEqual(FEATURES)
    expect(events.some((e) => e.type === 'error' && e.message.startsWith('Missing after this change'))).toBe(false)
  })

  it('says what is missing in the chat when the run still ends without it after two notes', async () => {
    const t = setup([...first, undo(2), { text: 'Rolled back.' }, { text: 'Still rolled back.' }, { text: 'Done for now.' }])
    await t.say('make a model')
    const events = await t.say('round off the upper blocks')
    expect(t.notes().filter((n) => n.startsWith('Before you answer: this turn took away'))).toHaveLength(1)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'Missing after this change: Stacks, Front pole.' })
  })

  it('lets a reply end that names what is missing on its first line', async () => {
    const t = setup([...first, undo(1), { text: 'Front pole is missing: it could not stand on the new top.\nThe rest is as before.' }])
    await t.say('make a model')
    const events = await t.say('move the top forward')
    expect(keepsNoteOf(t.notes())).toBeUndefined()
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('sends no note when the person asked to remove it', async () => {
    const t = setup([...first, undo(1), { text: 'Removed the front pole.' }])
    await t.say('make a model')
    await t.say('remove the front pole')
    expect(keepsNoteOf(t.notes())).toBeUndefined()
  })

  it('counts a feature turned off as taken away, and one built again beside the old one as doubled', async () => {
    const off = { calls: [{ name: 'design.edit_step', args: { design: 'd1', step: 4, suppressed: true } }] }
    const t = setup([...first, off, x('Front pole'), { text: 'Raked the pole.' }, { calls: [{ name: 'design.edit_step', args: { design: 'd1', step: 4, suppressed: false } }] }, { calls: [{ name: 'design.edit_step', args: { design: 'd1', step: 5, suppressed: true } }] }, { text: 'Raked the pole and kept the stacks.' }])
    await t.say('make a model')
    await t.say('rake the front pole back')
    const note = keepsNoteOf(t.notes())
    expect(note).toContain('took away Stacks')
    expect(note).toContain('step 5 still makes Front pole beside step 6, which made it again')
    expect(t.built.map((b) => `${b.feature} ${b.state}`)).toEqual(['Body done', 'Lower tier done', 'Upper tier done', 'Stacks done', 'Front pole suppressed', 'Front pole done'])
  })
})

describe('an amount the person gave stays', () => {
  it.each(['rake the poles back a little', 'rake the poles back 5 degrees'])('"%s" is never made larger', async (asked) => {
    const t = setup([...first, x('Lean'), { text: 'Raked it.' }], [0.8])
    await t.say('make a model')
    await t.say(asked)
    const notes = t.notes()
    expect(notes).toContain(keptAmountNote(0.8, 2))
    expect(notes.some((n) => n.includes('Grow each size'))).toBe(false)
    expect(notes).not.toContain(STRENGTHEN_NOTE(0.8, 2))
  })

  it('does not measure a step that only takes something away', async () => {
    const t = setup([...first, undo(1), x('Front pole'), { text: 'Rebuilt the pole.' }], [9])
    await t.say('make a model')
    t.log.length = 0
    await t.say('make the front pole thicker')
    expect(t.log).toEqual(['undo Front pole', 'extrude Front pole', 'compare 9'])
  })

  it('reads amounts and small asks, and leaves a plain ask alone', () => {
    expect(statesAmount('make it 10 mm taller')).toBe(true)
    expect(statesAmount('turn it 15° more')).toBe(true)
    expect(statesAmount('a bit wider please')).toBe(true)
    expect(statesAmount('add windows on every side')).toBe(false)
    expect(statesAmount('make 3 more')).toBe(false)
  })
})

describe('what counts as taken away', () => {
  const row = (id: string, feature: string, state = 'done', op = 'shape.extrude'): KeptRow => ({ id, name: id, op, feature, state })
  it('names a feature no step makes any more, and not one another step still makes', () => {
    const start = [row('a', 'Body'), row('b', 'Rail'), row('c', 'Rail')]
    expect(lostFeatures(start, [row('a', 'Body'), row('c', 'Rail')], 'thin the rail')).toBeNull()
    expect(lostFeatures(start, [row('a', 'Body')], 'thin the rail')).toEqual({ removed: ['Rail'], doubled: [] })
    expect(lostFeatures(start, [row('a', 'Body'), row('b', 'Rail', 'broken')], 'thin the rail')?.removed).toEqual(['Rail'])
  })
  it('reads a removal ask by its words', () => {
    expect(askedToRemove('remove the front pole', 'Front pole')).toBe(true)
    expect(askedToRemove('take off the rails', 'Side rail')).toBe(true)
    expect(askedToRemove('make the rails thinner', 'Side rail')).toBe(false)
    expect(askedToRemove('remove the logo', 'Side rail')).toBe(false)
  })
})
