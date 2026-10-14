// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A run always ends on a reply: a model that stops without a word, runs out of steps or is cut off at the output
// limit is asked once more with no tools, and the person gets a plain line if even that is empty. Sources under a
// reply are deduped and capped. The browser build's mimir offers no printers. A conversation resumes after a reload.
import type { Citation, PilotEvent, PilotMachine } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { createEvalEnv, type EvalObject } from '../evals/harness'
import { citedSources, MAX_CITED } from '../src/cite'
import { createScriptedClient } from '../src/provider/scripted'
import type { LlmClient, LlmEvent, LlmRequest } from '../src/provider/types'
import { CAD_TOOLS, CUT_NOTE, NO_REPLY_LINE, WRAP_NOTE } from '../src/runtime'

const MACHINE: PilotMachine = { printer: 'prusa_mk4s', material: 'pla', nozzle: 0.4 }
const BOX: EvalObject = { id: 'box', name: 'Box', bboxMm: [30, 20, 10] }

type Step = (req: LlmRequest) => LlmEvent[]

/** A client that answers each request with the events its step returns, and keeps the requests. */
function client(steps: Step[]): LlmClient & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  let i = 0
  return {
    provider: 'scripted',
    requests,
    async *stream(req) {
      requests.push(req)
      const step = steps[i++]
      for (const ev of step ? step(req) : [{ type: 'done', stop: 'end' } as LlmEvent]) yield ev
    },
  }
}

const say = (text: string): LlmEvent[] => [{ type: 'text', delta: text }, { type: 'done', stop: 'end' }]
const call = (id: string, name: string, args: unknown): LlmEvent[] => [{ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } }, { type: 'done', stop: 'tool_calls' }]

async function run(c: LlmClient, opts: { maxSteps?: number; scope?: 'cad' } = {}) {
  const env = createEvalEnv({ client: c, machine: MACHINE, objects: [BOX], ...(opts.maxSteps ? { config: { maxSteps: opts.maxSteps } } : {}), ...(opts.scope ? { scope: opts.scope } : {}) })
  const events: PilotEvent[] = []
  for await (const ev of env.pilot.run('s', 'make me a box', { context: { machine: MACHINE } })) events.push(ev)
  return { env, events, text: events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('') }
}

const lastUser = (req: LlmRequest): string => {
  const m = req.messages.findLast((x) => x.role === 'user')
  return m && m.role === 'user' ? m.content : ''
}

describe('a run always ends on a reply', () => {
  it('asks for a reply, with no tools, when the model stops after a tool call without a word', async () => {
    const c = client([() => call('c1', 'kb.search', { query: 'first layer' }), () => [{ type: 'done', stop: 'end' }], (req) => (req.toolChoice === 'none' && lastUser(req) === WRAP_NOTE ? say('I looked up the guides. What size should the box be?') : say('wrong'))])
    const { events, text } = await run(c)
    expect(text).toBe('I looked up the guides. What size should the box be?')
    expect(c.requests.at(-1)?.toolChoice).toBe('none')
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('says a plain line itself when the model stays silent even then', async () => {
    const c = client([() => [{ type: 'done', stop: 'end' }], () => [{ type: 'done', stop: 'end' }]])
    const { events, text } = await run(c)
    expect(text).toBe(NO_REPLY_LINE)
    expect(c.requests).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end' })
  })

  it('drops a step cut off at the output limit before it said anything, and asks again', async () => {
    const c = client([
      () => [{ type: 'reasoning', delta: 'a long plan '.repeat(20) }, { type: 'done', stop: 'length', raw: [{ type: 'thinking', thinking: 'cut' }] }],
      (req) => {
        // the cut step is not sent back: no assistant turn carries its half thought
        expect(req.messages.some((m) => m.role === 'assistant')).toBe(false)
        expect(lastUser(req)).toBe(CUT_NOTE)
        return say('Here is the plan in short.')
      },
    ])
    const { text } = await run(c)
    expect(text).toBe('Here is the plan in short.')
  })

  it('answers a tool call cut off at the output limit without running it', async () => {
    const c = client([
      () => [{ type: 'tool_call', call: { id: 'c1', name: 'text_to_part', arguments: '{}' } }, { type: 'done', stop: 'length' }],
      (req) => {
        const res = req.messages.findLast((m) => m.role === 'tool')
        expect(res && res.role === 'tool' ? res.content : '').toMatch(/cut off at the output limit/)
        return say('I will build it in smaller steps.')
      },
    ])
    const { env, events, text } = await run(c)
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringMatching(/^Cut off/) })
    expect(env.project.objects()).toHaveLength(1)
    expect(text).toBe('I will build it in smaller steps.')
  })

  it('out of steps, the last step has no tools and gives the reply', async () => {
    const steps: Step[] = [0, 1].map((n) => () => call(`c${n}`, 'kb.search', { query: `query ${n}` }))
    steps.push((req) => (req.toolChoice === 'none' && lastUser(req) === WRAP_NOTE ? say('Out of steps; here is where it stands.') : say('wrong')))
    const c = client(steps)
    const { events, text } = await run(c, { maxSteps: 2 })
    expect(text).toBe('Out of steps; here is where it stands.')
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_steps' })
  })

  it('a run with an answer is not asked again', async () => {
    const c = client([() => say('A box, coming up.')])
    const { text } = await run(c)
    expect(text).toBe('A box, coming up.')
    expect(c.requests).toHaveLength(1)
  })
})

describe('sources under a reply', () => {
  const src = (id: string, title: string, url: string, publisher?: string): Citation => ({ id, title, url, kind: 'kb', ...(publisher ? { publisher } : {}) })

  it('drops the same page under two ids and keeps the ones the reply names, strongest first', () => {
    const items = [
      src('a', 'Troubleshooting spaghetti in 3D printing', 'https://wiki.bambulab.com/en/spaghetti', 'Bambu Lab'),
      src('b', 'Spaghetti guide', 'https://wiki.bambulab.com/en/spaghetti/', 'Bambu Lab'),
      src('c', 'PETG drying and stringing', 'https://help.prusa3d.com/petg', 'Prusa Research'),
      src('d', 'Bed mesh', 'https://www.klipper3d.org/Bed_Mesh.html', 'Klipper project'),
    ]
    const cited = citedSources(items, 'Per Prusa, dry PETG first: wet filament gives stringing.')
    expect(cited.map((c) => c.id)).toEqual(['c'])
  })

  it('caps a long list and keeps a few when the reply names none', () => {
    const many = Array.from({ length: 104 }, (_, i) => src(`s${i}`, `Guide number ${i} about warping`, `https://example.com/${i}`, 'Example'))
    expect(citedSources(many, 'Warping comes from the example guides.').length).toBe(MAX_CITED)
    expect(citedSources(many, 'Use 0.2 mm.').length).toBe(3)
    // sources that only rode along with a part (its material's weight) are not shown under a reply that names none
    expect(citedSources(many, 'Built the part.', false)).toEqual([])
  })

  it('a run shows only the sources it settled on', async () => {
    const c = client([() => call('c1', 'kb.troubleshoot', { symptom: 'first layer not sticking' }), () => say('Clean the plate and slow the first layer.')])
    const { events } = await run(c)
    const cites = events.filter((e) => e.type === 'citations')
    expect(cites).toHaveLength(1)
    expect(cites[0]?.type === 'citations' ? cites[0].items.length : 0).toBeLessThanOrEqual(MAX_CITED)
  })
})

describe('the browser build that only models', () => {
  it('offers part, knowledge and app tools only, no plugins, and a prompt about parts', async () => {
    const c = createScriptedClient([{ text: 'Hi.' }])
    const env = createEvalEnv({ client: c, machine: MACHINE, objects: [BOX], scope: 'cad' })
    const events: PilotEvent[] = []
    for await (const ev of env.pilot.run('s', 'hi')) events.push(ev)
    expect(events.some((e) => e.type === 'plugins')).toBe(false)
    const names = env.pilot.tools().map((t) => t.name)
    expect(names).toContain('text_to_part')
    expect(names.every((n) => CAD_TOOLS.has(n) || n.startsWith('app.'))).toBe(true)
    expect(names.some((n) => n.startsWith('printer.'))).toBe(false)
    const system = c.requests[0]?.messages[0]
    expect(system?.role === 'system' ? system.content : '').toMatch(/in the browser, where people design parts/)
    expect(system?.role === 'system' ? system.content : '').not.toMatch(/plan batches across several printers/)
  })

  it('the full app keeps its printers and plugins', async () => {
    const c = createScriptedClient([{ text: 'Hi.' }])
    const env = createEvalEnv({ client: c, machine: MACHINE, objects: [BOX] })
    const events: PilotEvent[] = []
    for await (const ev of env.pilot.run('s', 'hi')) events.push(ev)
    expect(events.some((e) => e.type === 'plugins')).toBe(true)
    expect(env.pilot.tools().some((t) => t.name.startsWith('printer.'))).toBe(true)
  })
})

describe('resume', () => {
  it('gives a reloaded conversation back to the runtime as its history', async () => {
    const c = createScriptedClient([{ text: 'Sure, 30 mm.' }])
    const env = createEvalEnv({ client: c, machine: MACHINE, objects: [BOX] })
    env.pilot.resume?.('s', [{ user: 'make a box', reply: 'What size?' }])
    for await (const _ of env.pilot.run('s', '30 mm')) void _
    const sent = c.requests[0]?.messages.map((m) => `${m.role}:${m.role === 'tool' ? '' : m.content.slice(0, 40)}`) ?? []
    expect(sent.slice(1, 3)).toEqual(['user:User request:\nmake a box', 'assistant:What size?'])
  })
})
