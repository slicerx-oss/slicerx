// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A step cut off at the output limit can leave a run that started a design, said what it would build next and stopped
// with the design still empty. Such a reply goes on once (CUT_GO_ON_NOTE). A run with no cut, a design that has a body,
// a reply that asks the person a question, and a second such reply all end as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, DEFAULT_CONFIG } from '../src/index'
import type { LlmClient, LlmEvent, LlmRequest } from '../src/provider/types'
import { CUT_GO_ON_NOTE, CUT_NOTE } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }

const designNew = defineTool({
  name: 'design.new',
  version: '1.0.0',
  source: 'command',
  permission: 'slice',
  description: 'test',
  input: z.object({ name: z.string() }),
  async run(i) {
    return { summary: `Started ${i.name} (obj_1)`, output: { design: 'obj_1', name: i.name } }
  },
}) as PilotTool<never>

const extrude = defineTool({
  name: 'geom.extrude',
  version: '1.0.0',
  source: 'command',
  permission: 'slice',
  description: 'test',
  input: z.object({ design: z.string(), name: z.string() }),
  async run(i) {
    return { summary: `Built ${i.name}`, output: { design: i.design, parts: [{ name: i.name }] } }
  },
}) as PilotTool<never>

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

const cut: Step = () => [{ type: 'reasoning', delta: 'a long plan '.repeat(20) }, { type: 'done', stop: 'length', raw: [{ type: 'thinking', thinking: 'cut' }] }]
const say = (text: string): Step => () => [{ type: 'text', delta: text }, { type: 'done', stop: 'end' }]
const call = (id: string, name: string, args: unknown): Step => () => [{ type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } }, { type: 'done', stop: 'tool_calls' }]

const lastUser = (req: LlmRequest | undefined): string => {
  const m = req?.messages.findLast((x) => x.role === 'user')
  return m && m.role === 'user' ? m.content : ''
}

async function run(steps: Step[]) {
  const c = client(steps)
  const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: c, builtins: false, tools: [designNew, extrude] })
  let text = ''
  for await (const e of p.run('s', 'Make me a block')) if (e.type === 'text') text += e.delta
  // the notes the run sent, as the last request carries them
  const notes = (c.requests.at(-1)?.messages ?? []).filter((m) => m.role === 'user' && m.content === CUT_GO_ON_NOTE).length
  return { c, text, notes }
}

const START = call('c1', 'design.new', { name: 'Block' })
const NARRATE = say('I started the design. Next I will plan the block as a base and a top.')

describe('a reply after a cut goes on once while its design is empty', () => {
  it('goes on from a narrated next step after a cut, and builds', async () => {
    const { c, notes } = await run([cut, START, NARRATE, call('c2', 'geom.extrude', { design: 'obj_1', name: 'Base' }), say('Built the base.')])
    expect(lastUser(c.requests[1])).toBe(CUT_NOTE)
    expect(lastUser(c.requests[3])).toBe(CUT_GO_ON_NOTE)
    expect(notes).toBe(1)
    expect(c.requests).toHaveLength(5)
  })

  it('goes on once only', async () => {
    const { c, notes } = await run([cut, START, NARRATE, say('I will plan it next.')])
    expect(notes).toBe(1)
    expect(c.requests).toHaveLength(4)
  })

  it('ends as before with no cut in the run', async () => {
    const { c, notes } = await run([START, NARRATE])
    expect(notes).toBe(0)
    expect(c.requests).toHaveLength(2)
  })

  it('ends as before once the design has a body', async () => {
    const { notes } = await run([cut, START, call('c2', 'geom.extrude', { design: 'obj_1', name: 'Base' }), say('Built the base; the top comes next.')])
    expect(notes).toBe(0)
  })

  it('ends as before on a question for the person', async () => {
    const { notes } = await run([cut, START, say('I started the design. How tall should the block be?')])
    expect(notes).toBe(0)
  })

  it('ends as before with no design started', async () => {
    const { notes } = await run([cut, say('A block can be made from a single extrude.')])
    expect(notes).toBe(0)
  })
})
