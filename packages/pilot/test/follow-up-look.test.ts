// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up on a cloud turn is read against the model and made visible: the run looks at the design an earlier turn
// built before anything else, measures how much of the whole-model view each step of changes moved, and gives the model
// that measure. A change still under the floor a person sees at that view goes back once to be strengthened before the
// reply. A first build, and a local model, get none of this.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'
import { growBy, STRENGTHEN_NOTE, visibleNote } from '../src/runtime'

function setup(steps: ScriptStep[], shares: number[], pass = true) {
  const log: string[] = []
  const client = createScriptedClient(steps, { chunk: false })
  const extrude = defineTool<{ name: string; design?: string | undefined }>({
    name: 'geom.extrude',
    version: '1',
    description: 'One feature',
    source: 'command',
    permission: 'slice',
    input: z.object({ name: z.string(), design: z.string().optional() }),
    async run(i) {
      log.push(`extrude ${i.name}`)
      // a step the tool refuses leaves the design as it was
      if (i.name === 'Refused') return { ok: false, summary: 'That step could not be made, so the part is unchanged' }
      return { summary: `Built ${i.name}`, output: { design: i.design ?? 'd1' } }
    },
  })
  const look = defineTool<{ design: string; compare?: boolean | undefined }>({
    name: 'design.look',
    version: '1',
    description: 'Look',
    source: 'command',
    permission: 'read',
    input: z.object({ design: z.string(), compare: z.boolean().optional() }),
    async run(i) {
      if (!i.compare) {
        log.push(`look ${i.design}`)
        return { summary: 'Looked at the model', output: { design: i.design }, images: [{ mime: 'image/png' as const, data: 'AAAA' }] }
      }
      const pct = shares.shift() ?? 50
      log.push(`compare ${i.design} ${pct}`)
      return { summary: 'Looked at the model again', output: { design: i.design, visiblePct: pct, floorPct: 2, belowFloor: pct < 2 }, images: [{ mime: 'image/png' as const, data: 'BBBB' }] }
    },
  })
  const check = defineTool<{ planId: string }>({
    name: 'design.check',
    version: '1',
    description: 'Check',
    source: 'command',
    permission: 'read',
    input: z.object({ planId: z.string() }),
    async run() {
      log.push('check')
      return { summary: pass ? 'All checks pass' : 'One check failed', output: { design: 'd1', nozzleMm: 0.4, pass } }
    },
  })
  const p = createPilot({
    host: { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never,
    config: { ...DEFAULT_CONFIG, maxSteps: 20, maxToolCalls: 40 },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: [extrude, look, check] as never[],
  })
  const say = async (message: string) => {
    const events: PilotEvent[] = []
    for await (const e of p.run('s', message)) events.push(e)
    return events
  }
  const sent = () => (client.requests as { messages: { role: string; content: unknown }[] }[]).map((r) => r.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')))
  return { log, say, sent, client }
}

const x = (name: string) => ({ calls: [{ name: 'geom.extrude', args: { name, design: 'd1' } }] })
// a first build that ends checked against its plan: the next run on its design is a follow-up
const built: ScriptStep[] = [x('Hull'), { calls: [{ name: 'design.check', args: { planId: 'p1' } }] }, { text: 'Built the hull.' }]

describe('a follow-up on a built design', () => {
  it('looks first, measures the change, and sends a change under the floor back once', async () => {
    const { log, say, sent } = setup([...built, x('Bevel'), { text: 'Beveled the deck.' }, x('Bigger bevel'), { text: 'Made the bevel larger: 6% of the view.' }], [0.4, 6])
    await say('make a boat')
    // a first build: no look, no measure
    expect(log).toEqual(['extrude Hull', 'check'])
    log.length = 0
    await say('add bevels')
    expect(log).toEqual(['look d1', 'extrude Bevel', 'compare d1 0.4', 'extrude Bigger bevel', 'compare d1 6'])
    const notes = sent().flat()
    expect(notes.some((n) => n.startsWith('Measured: the change so far moved 0.4% of the whole-model view, under the 2%'))).toBe(true)
    expect(notes).toContain(STRENGTHEN_NOTE(0.4, 2))
    expect(notes).toContain('Measured: the change so far moved 6% of the whole-model view. Say that share in the reply.')
  })

  it('does not look at a design whose build was never checked, nor measure a build under way', async () => {
    const { log, say } = setup([x('Hull'), { text: 'Built the hull.' }, x('Deck'), { text: 'Added the deck.' }], [0.1])
    await say('make a boat')
    log.length = 0
    await say('keep going')
    expect(log).toEqual(['extrude Deck'])
  })

  it('follows a design whose build check failed too', async () => {
    const failed = { calls: [{ name: 'design.check', args: { planId: 'p1' } }] }
    const { log, say } = setup([x('Hull'), failed, { text: 'Built, one check failed.' }, x('Funnel'), { text: 'Added a funnel.' }], [9], false)
    await say('make a boat')
    log.length = 0
    await say('add a funnel')
    expect(log).toEqual(['look d1', 'extrude Funnel', 'compare d1 9'])
  })

  it('keeps the first look the only picture: the measure goes in as words, and a second look points back to the first', async () => {
    const own = { calls: [{ name: 'design.look', args: { design: 'd1' } }] }
    const { log, say, client } = setup([...built, own, x('Funnel'), { text: 'Added a funnel.' }], [9])
    await say('make a boat')
    log.length = 0
    await say('add a funnel')
    // the model's own look did not run again
    expect(log).toEqual(['look d1', 'extrude Funnel', 'compare d1 9'])
    const last = (client.requests as { messages: { role: string; images?: unknown[] }[] }[]).at(-1)!
    expect(last.messages.flatMap((m) => m.images ?? [])).toHaveLength(1)
  })

  it('measures only a step that changed the design: a refused change is not measured, nor counted under the floor', async () => {
    const { log, say, sent } = setup([...built, x('Refused'), x('Vents'), { text: 'Added vents.' }, x('Bigger vents'), { text: 'Made the vents larger.' }], [1, 6])
    await say('make a boat')
    log.length = 0
    await say('add deck details')
    // one measure for the vents, under the floor, so the change goes back once to be strengthened
    expect(log).toEqual(['look d1', 'extrude Refused', 'extrude Vents', 'compare d1 1', 'extrude Bigger vents', 'compare d1 6'])
    expect(sent().flat()).toContain(STRENGTHEN_NOTE(1, 2))
  })

  it('answers at once when the change shows', async () => {
    const { log, say, sent } = setup([...built, x('Funnel'), { text: 'Added a funnel, 9% of the view.' }], [9])
    await say('make a boat')
    log.length = 0
    await say('add a funnel')
    expect(log).toEqual(['look d1', 'extrude Funnel', 'compare d1 9'])
    expect(sent().flat().some((n) => n.startsWith('Before you answer'))).toBe(false)
  })

  it('strengthens only once: a second small measure lets the reply say the change is subtle', async () => {
    const { log, say, sent } = setup([...built, x('Bevel'), x('Bevel again'), { text: 'Beveled; it stays subtle.' }], [0.4, 0.9])
    await say('make a boat')
    log.length = 0
    await say('add bevels')
    expect(log).toEqual(['look d1', 'extrude Bevel', 'compare d1 0.4', 'extrude Bevel again', 'compare d1 0.9'])
    const notes = sent().flat()
    expect(notes.some((n) => n.includes('still under the 2%') && n.includes('say the change is subtle'))).toBe(true)
    expect(notes.some((n) => n.startsWith('Before you answer'))).toBe(false)
  })
})

describe('how much a change under the floor must grow', () => {
  it('scales each size by the square root of the shortfall, with a margin, from 1.5 to 4 times', () => {
    expect(growBy(0.8, 2)).toBe(2)
    expect(growBy(1.9, 2)).toBe(1.5)
    expect(growBy(0.1, 2)).toBe(4)
    expect(growBy(0, 2)).toBe(4)
  })

  it('tells the model the factor and to add contrast, never the same sizes again', () => {
    const note = visibleNote(0.8, 2)
    expect(note).toContain('about 2 times')
    expect(note).toContain('contrasting color')
    expect(note).toContain('rebuilt at the same sizes it measures the same')
    expect(STRENGTHEN_NOTE(0.8, 2)).toContain('about 2 times the sizes')
    expect(STRENGTHEN_NOTE(0, 2)).not.toContain('times the sizes')
    // a change that shows says its share, with no push to grow
    expect(visibleNote(6, 2)).toBe('Measured: the change so far moved 6% of the whole-model view. Say that share in the reply.')
  })
})
