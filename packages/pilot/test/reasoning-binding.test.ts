// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Signed reasoning is bound to the system prompt, tools and model of the request it came from, and the provider refuses
// it (and everything signed after it) once a later request changes any of them. A follow-up whose tool set or model
// differs from the run before it sends that run without its reasoning; the run in progress keeps its own through its
// tool loop, and a follow-up that changes nothing keeps all of it.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../src/config'
import type { LlmMessage } from '../src/provider/types'
import { encodeToolName } from '../src/provider/openai'
import { unbindOldReasoning } from '../src/reasoning-binding'
import { createPilot } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'

const BASE = 'https://abcdefghijklmnop.supabase.co/functions/v1/mimir'

/** One scripted answer: signed reasoning, then words or tool calls. */
type Reply = { think: string; text: string } | { think: string; calls: string[] }

const sse = (events: unknown[]): string => events.map((d) => `event: ${(d as { type: string }).type}\ndata: ${JSON.stringify(d)}\n\n`).join('')

function body(r: Reply): string {
  const thought = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: r.think } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${r.think}` } },
    { type: 'content_block_stop', index: 0 },
  ]
  const rest =
    'text' in r
      ? [
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: r.text } },
          { type: 'content_block_stop', index: 1 },
        ]
      : r.calls.flatMap((name, i) => [
          { type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: `call_${r.think}_${i}`, name: encodeToolName(name), input: {} } },
          { type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
          { type: 'content_block_stop', index: i + 1 },
        ])
  const stop = 'text' in r ? 'end_turn' : 'tool_use'
  return sse([{ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } }, ...thought, ...rest, { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: 'message_stop' }])
}

/** A proxy that answers each request with the next reply and keeps what it was sent. */
function proxy(replies: Reply[]): { t: LlmTransport; sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    t: {
      available: async () => true,
      async *stream(req) {
        const n = i++
        sent.push(req)
        yield new TextEncoder().encode(body(replies[n] ?? { think: `extra${n}`, text: 'Done.' }))
      },
    },
  }
}

type Sent = { messages: { role: string; content: unknown }[]; tools?: { name: string; description: string }[] }
const parsed = (r: LlmHttpRequest | undefined): Sent => JSON.parse(String(r?.body)) as Sent

/** The reasoning a request carries, by its words, in order. */
function reasoning(r: LlmHttpRequest | undefined): string[] {
  return parsed(r).messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; thinking?: string }[]).filter((b) => b.type === 'thinking').map((b) => b.thinking ?? '') : []))
}

/** Every assistant message's words still go back, with or without its reasoning. */
function replies(r: LlmHttpRequest | undefined): string[] {
  return parsed(r)
    .messages.filter((m) => m.role === 'assistant')
    .flatMap((m) => (Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '') : [String(m.content)]))
}

const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
const NO_APPROVALS = { register: async () => undefined, grant: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
const CLOUD = { ...DEFAULT_CONFIG, provider: 'mimir-cloud', model: 'claude-haiku-5-5', baseUrl: BASE, billing: 'key' as const, webSearch: false }

const tool = (name: string): PilotTool<never> =>
  defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: `${name} for the test`, input: z.object({}).passthrough(), run: async () => ({ summary: `${name} ran` }) }) as PilotTool<never>

function chat(t: LlmTransport, tools: PilotTool<never>[], hasDesign: () => boolean = () => false) {
  const pilot = createPilot({ host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: t }, config: CLOUD, policy: DEFAULT_POLICY, builtins: false, tools, hasDesign })
  return async (message: string): Promise<void> => {
    for await (const _e of pilot.run('ses_1', message)) void _e
  }
}

describe('signed reasoning across runs', () => {
  it('a follow-up that changes nothing sends the first run back whole', async () => {
    const { t, sent } = proxy([
      { think: 'a1', text: 'Yes, at up to 65 C.' },
      { think: 'b1', text: 'Yes, at 65 C for 8 hours.' },
    ])
    const say = chat(t, [tool('part.look')])
    await say('Can the AMS 2 Pro dry nylon?')
    await say('And can it dry PETG?')
    expect(sent).toHaveLength(2)
    expect(sent.map((r) => r.headers['x-sx-tier'])).toEqual(['base', 'base'])
    expect(reasoning(sent[1])).toEqual(['a1'])
  })

  it('a follow-up with another tool set sends the first run without its reasoning and keeps its own through its tool loop', async () => {
    const look = tool('part.look')
    const { t, sent } = proxy([
      { think: 'a1', calls: ['part.look'] },
      { think: 'a2', text: 'Yes, at up to 65 C.' },
      { think: 'b1', calls: ['part.look'] },
      { think: 'b2', text: 'Yes, at 65 C for 8 hours.' },
    ])
    const say = chat(t, [look])
    await say('Can the AMS 2 Pro dry nylon?')
    expect(reasoning(sent[1])).toEqual(['a1'])
    // the turn sets offer a changed tool on the next run, as a swap of toolsets does
    ;(look as { description: string }).description = 'part.look, now with the side view'
    await say('And can it dry PETG?')
    expect(sent).toHaveLength(4)
    expect(sent.map((r) => r.headers['x-sx-tier'])).toEqual(['base', 'base', 'base', 'base'])
    expect(parsed(sent[2]).tools?.find((x) => x.name === 'part__look')?.description).toBe('part.look, now with the side view')
    // the first run's words go back, its reasoning does not
    expect(reasoning(sent[2])).toEqual([])
    expect(replies(sent[2])).toContain('Yes, at up to 65 C.')
    // this run's own reasoning goes back through its tool loop
    expect(reasoning(sent[3])).toEqual(['b1'])
  })

  it('a follow-up on another model drops the reasoning before it, and dropped reasoning never comes back', async () => {
    let design = false
    const { t, sent } = proxy([
      { think: 'a1', text: 'Here is a 30 mm cube.' },
      { think: 'b1', text: 'It is 40 mm tall now.' },
      { think: 'c1', text: 'Here is a 20 mm cylinder.' },
    ])
    const say = chat(t, [tool('design.new')], () => design)
    await say('Make me a 30 mm cube')
    design = true
    await say('Make it 10 mm taller')
    await say('Make me a new part: a 20 mm cylinder')
    expect(sent).toHaveLength(3)
    expect(sent.map((r) => r.headers['x-sx-tier'])).toEqual(['step', 'base', 'step'])
    expect(reasoning(sent[1])).toEqual([])
    expect(reasoning(sent[2])).toEqual([])
    expect(replies(sent[2])).toEqual(['Here is a 30 mm cube.', 'It is 40 mm tall now.'])
  })
})

describe('unbindOldReasoning', () => {
  const said = (think: string, bound: string): LlmMessage => ({ role: 'assistant', content: think, raw: [{ type: 'thinking', thinking: think, signature: 's' }, { type: 'text', text: think }], bound })
  const left = (ms: LlmMessage[]) => ms.flatMap((m) => (m.role === 'assistant' ? (m.raw ?? []).filter((b) => (b as { type: string }).type === 'thinking').map((b) => (b as { thinking: string }).thinking) : []))

  it('removes from the oldest end up to the newest message bound to something else, and leaves the run in progress', () => {
    const ms: LlmMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'one' }, said('a', 'k1'), { role: 'user', content: 'two' }, said('b', 'k2'), said('c', 'k1'), { role: 'user', content: 'three' }, said('d', 'k2')]
    expect(unbindOldReasoning(ms, 7, 'k1')).toBe(2)
    // b is bound to k2, so a and b leave; c is bound to k1 and stays; d is this run's own
    expect(left(ms)).toEqual(['c', 'd'])
    expect(ms[4]).toEqual({ role: 'assistant', content: 'b', raw: [{ type: 'text', text: 'b' }] })
  })

  it('changes nothing when every earlier message is bound to the same request', () => {
    const ms: LlmMessage[] = [{ role: 'user', content: 'one' }, said('a', 'k1'), { role: 'user', content: 'two' }]
    const before = JSON.stringify(ms)
    expect(unbindOldReasoning(ms, 3, 'k1')).toBe(0)
    expect(JSON.stringify(ms)).toBe(before)
  })

  it('treats reasoning with no record of its request as bound to something else', () => {
    const ms: LlmMessage[] = [{ role: 'user', content: 'one' }, { role: 'assistant', content: '', raw: [{ type: 'redacted_thinking', data: 'x' }] }, { role: 'user', content: 'two' }]
    expect(unbindOldReasoning(ms, 3, 'k1')).toBe(1)
    expect(ms[1]).toEqual({ role: 'assistant', content: '' })
  })
})
