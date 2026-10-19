// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir cloud and the stronger model: a hard turn (a picture to build from, deep work, a many-step part, a run that keeps
// failing) asks the proxy for it with x-sx-tier: step, anything else sends base. The proxy decides within the edition's
// limits and names the model it used in x-sx-model, and the chat's model label follows that, not the hint.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import { HUGINN, MUNINN } from '../src/models'
import { cloudHeaders, cloudModel, createTransportClient } from '../src/provider/client'
import { createPilot } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'
import { z } from 'zod'

const BASE = 'https://abcdefghijklmnop.supabase.co/functions/v1/mimir'
const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'

type Reply = { text: string } | { calls: { name: string; args: unknown }[] }

const sse = (events: unknown[]): string => events.map((d) => `event: ${(d as { type: string }).type}\ndata: ${JSON.stringify(d)}\n\n`).join('')

function body(reply: Reply): string {
  if ('text' in reply) {
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])
  }
  const blocks = reply.calls.flatMap((c, i) => [
    { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `call_${i}`, name: c.name, input: {} } },
    { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args) } },
    { type: 'content_block_stop', index: i },
  ])
  return sse([{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }, ...blocks, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }])
}

/** A host transport that answers each request with the next scripted reply, naming the model the proxy used. */
function proxy(replies: Reply[], models: (string | undefined)[] = []): { t: LlmTransport; sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    t: {
      available: async () => true,
      async *stream(req, _signal, onHeaders) {
        const n = i++
        sent.push(req)
        const model = models[n]
        if (model) onHeaders?.({ 'x-sx-model': model })
        yield new TextEncoder().encode(body(replies[n] ?? { text: 'Done.' }))
      },
    },
  }
}

const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
const NO_APPROVALS = { register: async () => undefined, grant: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
const CLOUD = { ...DEFAULT_CONFIG, provider: 'mimir-cloud', model: HAIKU, baseUrl: BASE, billing: 'key' as const, webSearch: false }

async function run(t: LlmTransport, message: string, opts: { design?: boolean; attachments?: PilotAttachment[] } = {}): Promise<PilotEvent[]> {
  const pilot = createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: t },
    config: CLOUD,
    policy: DEFAULT_POLICY,
    builtins: false,
    // the mimir tab gives its runtime the design tools, and Auto then routes a build by the request
    tools: opts.design ? [designNew] : [],
  })
  const ev: PilotEvent[] = []
  for await (const e of pilot.run('ses_1', message, opts.attachments ? { attachments: opts.attachments } : {})) ev.push(e)
  return ev
}

const designNew = defineTool({ name: 'design.new', version: '1.0.0', source: 'command', permission: 'read', description: 'design.new for the test', input: z.object({}).passthrough(), run: async () => ({ summary: 'new design' }) }) as PilotTool<never>

const tiers = (sent: LlmHttpRequest[]): (string | undefined)[] => sent.map((r) => r.headers['x-sx-tier'])
const switches = (ev: PilotEvent[]): string[] => ev.flatMap((e) => (e.type === 'model_switch' ? [e.model] : []))
const drawing: PilotAttachment = { id: 'd', name: 'drawing.png', type: 'image/png', bytes: 10, url: 'data:image/png;base64,AAAA' }

describe('the tier header', () => {
  it('says step on muninn and base otherwise, with or without a share setting', () => {
    expect(cloudHeaders(undefined, 'ses_1', MUNINN)).toEqual({ 'x-sx-tier': 'step' })
    expect(cloudHeaders(undefined, 'ses_1', HUGINN)).toEqual({ 'x-sx-tier': 'base' })
    expect(cloudHeaders(undefined, 'ses_1')).toEqual({ 'x-sx-tier': 'base' })
    expect(cloudHeaders({ on: false, version: '0.2.0' }, 'ses_1', MUNINN)).toEqual({ 'x-sx-tier': 'step', 'x-sx-share': '0' })
  })

  it('never goes on another provider\'s request', async () => {
    const { t, sent } = proxy([{ text: 'Hi.' }])
    const client = createTransportClient(t, 'anthropic')
    for await (const _ of client.stream({ model: HAIKU, messages: [{ role: 'user', content: 'hi' }], tools: [], tier: MUNINN })) void _
    expect(sent[0]?.headers['x-sx-tier']).toBeUndefined()
  })
})

describe('mimir cloud asks for the stronger model on hard turns', () => {
  it('a picture turn sends step', async () => {
    const { t, sent } = proxy([{ text: 'How thick is the plate?' }])
    await run(t, 'Model this part from the drawing I attached.', { attachments: [drawing] })
    expect(tiers(sent)).toEqual(['step'])
  })

  it('a plain question sends base', async () => {
    const { t, sent } = proxy([{ text: 'Yes, it can.' }])
    await run(t, 'Can the AMS 2 Pro dry nylon?')
    expect(tiers(sent)).toEqual(['base'])
  })

  it('two failed tools send step from then on', async () => {
    const fail = { calls: [{ name: 'no_such_tool', args: {} }] }
    const { t, sent } = proxy([fail, fail, fail, { text: 'Done.' }])
    await run(t, 'Make my print faster')
    expect(tiers(sent)).toEqual(['base', 'base', 'step', 'step'])
  })

  it("the tab's many-step part sends step", async () => {
    const { t, sent } = proxy([{ text: 'Building it.' }])
    await run(t, 'A spur gear with 20 teeth and a 5 mm bore', { design: true })
    expect(tiers(sent)).toEqual(['step'])
    const plain = proxy([{ text: 'Building it.' }])
    await run(plain.t, 'Make me a 30 mm cube', { design: true })
    expect(tiers(plain.sent)).toEqual(['base'])
  })
})

describe('the model label', () => {
  it('the label follows x-sx-model', async () => {
    // a step hint answered by Sonnet, then the same hint answered by Haiku (the proxy fell back past its limits)
    const look = { calls: [{ name: 'no_such_tool', args: {} }] }
    const { t, sent } = proxy([look, { text: 'The bed is too cold.' }], [SONNET, HAIKU])
    const ev = await run(t, 'Why did my print fail?')
    expect(tiers(sent)).toEqual(['step', 'step'])
    expect(switches(ev)).toEqual([SONNET, HAIKU])
    const last = ev.filter((e) => e.type === 'model_switch').at(-1)
    expect(last).toMatchObject({ model: HAIKU, label: 'Haiku 5.5' })
  })

  it('shows a switch before the reply text, and none when the reply names no model', async () => {
    const { t } = proxy([{ text: 'On it.' }], [SONNET])
    const ev = await run(t, 'Why did my print fail?')
    const at = ev.findIndex((e) => e.type === 'model_switch')
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(ev.findIndex((e) => e.type === 'text'))
    const quiet = proxy([{ text: 'On it.' }])
    expect(switches(await run(quiet.t, 'Why did my print fail?'))).toEqual([])
  })

  it('ignores a model header that is not a plain model id', () => {
    expect(cloudModel({ 'x-sx-model': HAIKU })).toBe(HAIKU)
    expect(cloudModel({ 'x-sx-model': '<b>x</b>' })).toBeUndefined()
    expect(cloudModel({})).toBeUndefined()
    expect(cloudModel(undefined)).toBeUndefined()
  })
})
