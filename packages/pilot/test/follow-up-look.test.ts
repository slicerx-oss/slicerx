// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A follow-up on a cloud turn is read against the model: the run looks at the design an earlier turn built before
// anything else. A first build, and a local model, get none of this.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type ScriptStep } from '../src/index'
import { LOOK_AGAIN_NOTE } from '../src/runtime'

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
      return { summary: 'Looked at the model again', output: { design: i.design, visiblePct: pct }, images: [{ mime: 'image/png' as const, data: 'BBBB' }] }
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
const built: ScriptStep[] = [x('Body'), { calls: [{ name: 'design.check', args: { planId: 'p1' } }] }, { text: 'Built the body.' }]

describe('a follow-up on a built design', () => {
  it('looks first on a follow-up, and never on a first build', async () => {
    const { log, say } = setup([...built, x('Bevel'), { text: 'Beveled the top.' }], [])
    await say('make a toy car')
    // a first build: no look
    expect(log).toEqual(['extrude Body', 'check'])
    log.length = 0
    await say('add bevels')
    expect(log).toEqual(['look d1', 'extrude Bevel'])
  })

  it('does not look at a design whose build was never checked, nor measure a build under way', async () => {
    const { log, say } = setup([x('Body'), { text: 'Built the body.' }, x('Roof'), { text: 'Added the roof.' }], [0.1])
    await say('make a toy car')
    log.length = 0
    await say('keep going')
    expect(log).toEqual(['extrude Roof'])
  })

  it('follows a design whose build check failed too', async () => {
    const failed = { calls: [{ name: 'design.check', args: { planId: 'p1' } }] }
    const { log, say } = setup([x('Body'), failed, { text: 'Built, one check failed.' }, x('Spoiler'), { text: 'Added a spoiler.' }], [9], false)
    await say('make a toy car')
    log.length = 0
    await say('add a spoiler')
    expect(log).toEqual(['look d1', 'extrude Spoiler'])
  })

  it('keeps the first look the only picture: a second look points back to the first', async () => {
    const own = { calls: [{ name: 'design.look', args: { design: 'd1' } }] }
    const { log, say, client } = setup([...built, own, x('Spoiler'), { text: 'Added a spoiler.' }], [9])
    await say('make a toy car')
    log.length = 0
    await say('add a spoiler')
    // the model's own look did not run again
    expect(log).toEqual(['look d1', 'extrude Spoiler'])
    const last = (client.requests as { messages: { role: string; images?: unknown[] }[] }[]).at(-1)!
    expect(last.messages.flatMap((m) => m.images ?? [])).toHaveLength(1)
  })

  it('answers a second look after a change with what the first picture shows, and points to one compare after the last change', async () => {
    const own = { calls: [{ name: 'design.look', args: { design: 'd1' } }] }
    const { log, say, client } = setup([...built, x('Spoiler'), own, { text: 'Added a spoiler.' }], [9])
    await say('make a toy car')
    log.length = 0
    await say('add a spoiler')
    // the change ran, and the look after it did not run again
    expect(log).toEqual(['look d1', 'extrude Spoiler'])
    const answers = (client.requests as { messages: { role: string; content: unknown }[] }[]).at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(String(m.content)) as { summary?: string })
    expect(answers.at(-1)!.summary).toBe(LOOK_AGAIN_NOTE)
    // never that the model is unchanged, once a step has changed it
    expect(answers.at(-1)!.summary).not.toContain('has not changed')
    expect(LOOK_AGAIN_NOTE).toContain('compare true')
  })
})
