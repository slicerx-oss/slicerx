// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Signed reasoning is bound to the system prompt and tools of the request it came from, and the provider refuses it (and
// everything signed after it) once a later request changes either. A follow-up whose tool set or model differs from the
// run before it sends that run without its reasoning; the run in progress keeps its own through its tool loop, and a
// follow-up that changes neither, a move to muninn on the same model included, keeps all of it.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_CONFIG } from '../src/config'
import type { LlmMessage, LlmToolDef } from '../src/provider/types'
import { encodeToolName } from '../src/provider/openai'
import { bindingKey, unbindOldReasoning } from '../src/reasoning-binding'
import { createPilot } from '../src/runtime'
import { defineTool, type PilotTool, type Toolset } from '../src/tool'
import { LOAD_TOOLS_TOOL } from '../src/toolsets'


const BASE = 'https://abcdefghijklmnop.supabase.co/functions/v1/mimir'

/** One scripted answer: signed reasoning, then words or tool calls (a name, or a name and its arguments). */
type Call = string | { name: string; args: unknown }
type Reply = { think: string; text: string } | { think: string; calls: Call[] }

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
      : r.calls.flatMap((c, i) => [
          { type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: `call_${r.think}_${i}`, name: encodeToolName(typeof c === 'string' ? c : c.name), input: {} } },
          { type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: typeof c === 'string' ? '{}' : JSON.stringify(c.args) } },
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

type Sent = { model?: string; system?: unknown; messages: { role: string; content: unknown }[]; tools?: { name: string; description: string }[] }
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
/** A Claude model without tool search: its chat sends the tools each turn picks, so the list can change (toolsets.ts). */
const PICKED = { ...CLOUD, model: 'claude-haiku-4-5' }
/** A person's own key on the Messages API, which takes tool search from a chat's first request (tool-search.ts). */
const SEARCHING = { ...CLOUD, provider: 'anthropic' }
const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'
/** Auto on a person's own key: huginn and muninn are two models (models.ts modelFor). */
const AUTO = { ...SEARCHING, auto: true, models: { huginn: HAIKU, muninn: SONNET } }

const tool = (name: string, toolset?: Toolset): PilotTool<never> =>
  defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: `${name} for the test`, ...(toolset ? { toolset } : {}), input: z.object({}).passthrough(), run: async () => ({ summary: `${name} ran` }) }) as PilotTool<never>

/** 150 tools, over the cloud chat's limit of 128: core 10, cad 60, settings 30, printers 20, fleets 15, theme 15. */
/** A design check that finds the part off its plan, which moves a huginn run up to muninn (runtime.ts). */
const failedCheck = defineTool({ name: 'design.check', version: '1.0.0', source: 'command', permission: 'read', description: 'design.check for the test', input: z.object({}).passthrough(), run: async () => ({ summary: 'Ship (obj_1): 1 of 6 checks failed', output: { design: 'obj_1', nozzleMm: 0.4, pass: false } }) }) as PilotTool<never>

function overLimit(): PilotTool<never>[] {
  const sets: [string, Toolset, number][] = [
    ['core.t', 'core', 10],
    ['geom.t', 'cad', 60],
    ['settings.t', 'settings', 30],
    ['printer.t', 'printers', 20],
    ['fleet.t', 'fleets', 15],
    ['theme.t', 'theme', 15],
  ]
  return sets.flatMap(([prefix, set, n]) => Array.from({ length: n }, (_, i) => tool(`${prefix}${i}`, set)))
}

/** What a request binds the reasoning it gets back to, as the provider sees it: the model, system prompt and tools. */
const prefixOf = (r: LlmHttpRequest | undefined): string => {
  const b = parsed(r)
  return JSON.stringify([b.model, b.system, b.tools])
}

/**
 * Each request carries only reasoning signed against the same model, system prompt and tools: request n returned reply
 * n's reasoning, so a block's words name the request it was signed for.
 */
function unboundReasoning(sent: LlmHttpRequest[], said: Reply[]): string[] {
  const signedFor = new Map(said.map((r, n) => [r.think, sent[n]]))
  return sent.flatMap((r, n) => reasoning(r).filter((w) => prefixOf(signedFor.get(w)) !== prefixOf(r)).map((w) => `request ${n} carries ${w}`))
}

function chat(t: LlmTransport, tools: PilotTool<never>[], hasDesign: () => boolean = () => false, config: typeof CLOUD = CLOUD) {
  const pilot = createPilot({ host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: t }, config, policy: DEFAULT_POLICY, builtins: false, tools, hasDesign })
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
    const say = chat(t, [look], undefined, PICKED)
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

  it('a follow-up on a model with tool search sends each tool as first sent, so the first run keeps its reasoning', async () => {
    const look = tool('part.look')
    const { t, sent } = proxy([
      { think: 'a1', calls: ['part.look'] },
      { think: 'a2', text: 'Yes, at up to 65 C.' },
      { think: 'b1', text: 'Yes, at 65 C for 8 hours.' },
    ])
    const say = chat(t, [look], undefined, SEARCHING)
    await say('Can the AMS 2 Pro dry nylon?')
    ;(look as { description: string }).description = 'part.look, now with the side view'
    await say('And can it dry PETG?')
    expect(sent).toHaveLength(3)
    expect(parsed(sent[2]).tools).toEqual(parsed(sent[0]).tools)
    expect(parsed(sent[2]).tools?.find((x) => x.name === 'part__look')?.description).toBe('part.look for the test')
    expect(reasoning(sent[2])).toEqual(['a1', 'a2'])
  })

  it('a follow-up on another model drops the reasoning before it, and dropped reasoning never comes back', async () => {
    let design = false
    const { t, sent } = proxy([
      { think: 'a1', text: 'Here is a 30 mm cube.' },
      { think: 'b1', text: 'It is 40 mm tall now.' },
      { think: 'c1', text: 'Here is a 20 mm cylinder.' },
    ])
    // Auto on a person's own key: muninn and huginn are two models, so a move between them is a change of model
    const say = chat(t, [tool('design.new')], () => design, AUTO)
    await say('Make me a 30 mm cube')
    design = true
    await say('Make it 10 mm taller')
    await say('Make me a new part: a 20 mm cylinder')
    expect(sent).toHaveLength(3)
    expect(sent.map((r) => parsed(r).model)).toEqual([SONNET, HAIKU, SONNET])
    expect(reasoning(sent[1])).toEqual([])
    expect(reasoning(sent[2])).toEqual([])
    expect(replies(sent[2])).toEqual(['Here is a 30 mm cube.', 'It is 40 mm tall now.'])
  })

  it('a follow-up on the same model keeps the reasoning before it when the tier moves, so its messages go out as before', async () => {
    let design = false
    const said: Reply[] = [
      { think: 'a1', calls: ['design.new'] },
      { think: 'a2', text: 'Here is the ship.' },
      { think: 'b1', calls: ['design.check'] },
      { think: 'b2', text: 'One check failed.' },
      { think: 'c1', calls: ['design.check'] },
      { think: 'c2', text: 'It still fails.' },
      { think: 'd1', text: 'Here are the portholes.' },
    ]
    const { t, sent } = proxy(said)
    const say = chat(t, [tool('design.new'), tool('design.look'), failedCheck], () => design)
    await say('Make me a Titanic')
    design = true
    await say('Add rows of portholes along both sides of the hull.')
    await say('Add a row of windows along both sides of the deck houses.')
    await say('Add a row of lifeboats along each side of the top deck.')
    expect(sent).toHaveLength(7)
    // a new part starts on muninn, a follow-up on huginn, and the failed check moves each follow-up up to muninn
    expect(sent.map((r) => r.headers['x-sx-tier'])).toEqual(['step', 'step', 'base', 'step', 'base', 'step', 'base'])
    // mimir cloud names one model for both tiers, so every request is bound to the same one
    expect(new Set(sent.map((r) => parsed(r).model))).toEqual(new Set(['claude-haiku-5-5']))
    // no reasoning ever leaves: each request carries all of it, across the moves up and the runs after them
    expect(reasoning(sent[6])).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2'])
    // each request's messages start with the one before it, byte for byte, so the cached history holds
    for (let n = 1; n < sent.length; n++) {
      const before = parsed(sent[n - 1]).messages
      expect(JSON.stringify(parsed(sent[n]).messages.slice(0, before.length))).toBe(JSON.stringify(before))
    }
  })
})

describe('bindingKey', () => {
  const ms = (system: string): LlmMessage[] => [{ role: 'system', content: system }, { role: 'user', content: 'one' }]
  const defs = (description: string): LlmToolDef[] => [{ name: 'part.look', description, parameters: { type: 'object', properties: {} } }]
  const prefix = (key: string) => key.slice(0, key.indexOf(':'))

  it('is the same for the same system prompt, tools and model, whatever else the request sets', () => {
    expect(bindingKey('m1', ms('s'), defs('look'))).toBe(bindingKey('m1', [...ms('s'), { role: 'user', content: 'two' }], defs('look')))
  })

  it('changes with the model in its second part only', () => {
    const a = bindingKey('m1', ms('s'), defs('look'))
    const b = bindingKey('m2', ms('s'), defs('look'))
    expect(b).not.toBe(a)
    expect(prefix(b)).toBe(prefix(a))
  })

  it('changes in its first part with the system prompt or the tools', () => {
    const a = bindingKey('m1', ms('s'), defs('look'))
    expect(prefix(bindingKey('m1', ms('s2'), defs('look')))).not.toBe(prefix(a))
    expect(prefix(bindingKey('m1', ms('s'), defs('look again')))).not.toBe(prefix(a))
  })
})

describe('signed reasoning when pilot.load_tools changes the tools in the middle of a turn', () => {
  it('the step after the load sends no reasoning signed against the old tool list, and the tool loop goes on with its new reasoning', async () => {
    const said: Reply[] = [
      { think: 'a1', text: 'Here is the bracket.' },
      { think: 'b1', calls: [{ name: LOAD_TOOLS_TOOL, args: { toolset: 'theme' } }] },
      { think: 'b2', calls: ['theme.t0'] },
      { think: 'b3', text: 'Done, it is switched.' },
    ]
    const { t, sent } = proxy(said)
    const say = chat(t, overLimit(), undefined, PICKED)
    await say('Make me a bracket')
    await say('And then?')
    expect(sent).toHaveLength(4)
    // the load changed the tool list between the turn's first and second step
    const names = (r: LlmHttpRequest | undefined) => (parsed(r).tools ?? []).map((x) => x.name)
    expect(names(sent[1]).some((n) => n.startsWith('theme__'))).toBe(false)
    expect(names(sent[2]).some((n) => n.startsWith('theme__'))).toBe(true)
    expect(names(sent[2]).length).toBeLessThanOrEqual(128)
    expect(unboundReasoning(sent, said)).toEqual([])
    // the step after the load carries no reasoning at all: everything before it was signed against the old list
    expect(reasoning(sent[2])).toEqual([])
    // the tool loop still has the load's call and result, and the earlier turn's words
    const loadCall = parsed(sent[2]).messages.some((m) => Array.isArray(m.content) && (m.content as { type: string; name?: string }[]).some((b) => b.type === 'tool_use' && b.name === 'pilot__load_tools'))
    expect(loadCall).toBe(true)
    expect(replies(sent[2])).toContain('Here is the bracket.')
    // on the same tool list again, the run's new reasoning goes back through its loop
    expect(reasoning(sent[3])).toEqual(['b2'])
    expect(JSON.stringify(parsed(sent[3]).messages)).toContain('theme.t0 ran')
  })
})

describe('unbindOldReasoning', () => {
  const said = (think: string, bound: string): LlmMessage => ({ role: 'assistant', content: think, raw: [{ type: 'thinking', thinking: think, signature: 's' }, { type: 'text', text: think }], bound })
  const left = (ms: LlmMessage[]) => ms.flatMap((m) => (m.role === 'assistant' ? (m.raw ?? []).filter((b) => (b as { type: string }).type === 'thinking').map((b) => (b as { thinking: string }).thinking) : []))

  // keys are the system prompt and tools, a colon, then the model (bindingKey)
  const k1 = 'p1:m1'
  const k2 = 'p1:m2'

  it('removes from the oldest end up to the newest message bound to something else, and leaves the run in progress on another model', () => {
    const ms: LlmMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'one' }, said('a', k1), { role: 'user', content: 'two' }, said('b', k2), said('c', k1), { role: 'user', content: 'three' }, said('d', k2)]
    expect(unbindOldReasoning(ms, 7, k1)).toBe(2)
    // b is bound to another model, so a and b leave; c is bound to k1 and stays; d is this run's own, signed against the
    // same system prompt and tools
    expect(left(ms)).toEqual(['c', 'd'])
    expect(ms[4]).toEqual({ role: 'assistant', content: 'b', raw: [{ type: 'text', text: 'b' }] })
  })

  it('removes the run in progress too once its system prompt or tools change, and keeps the tool calls', () => {
    const call = { type: 'tool_use', id: 't1', name: 'pilot__load_tools', input: { toolset: 'project' } }
    const ms: LlmMessage[] = [{ role: 'user', content: 'one' }, said('a', k1), { role: 'user', content: 'two' }, { role: 'assistant', content: '', raw: [{ type: 'thinking', thinking: 'b', signature: 's' }, call], bound: k1 }, { role: 'tool', callId: 't1', content: 'loaded' }]
    expect(unbindOldReasoning(ms, 3, 'p2:m1')).toBe(2)
    expect(left(ms)).toEqual([])
    expect(ms[3]).toEqual({ role: 'assistant', content: '', raw: [call] })
  })

  it('changes nothing when every earlier message is bound to the same request', () => {
    const ms: LlmMessage[] = [{ role: 'user', content: 'one' }, said('a', k1), { role: 'user', content: 'two' }]
    const before = JSON.stringify(ms)
    expect(unbindOldReasoning(ms, 3, k1)).toBe(0)
    expect(JSON.stringify(ms)).toBe(before)
  })

  it('treats reasoning with no record of its request as bound to something else', () => {
    const ms: LlmMessage[] = [{ role: 'user', content: 'one' }, { role: 'assistant', content: '', raw: [{ type: 'redacted_thinking', data: 'x' }] }, { role: 'user', content: 'two' }]
    expect(unbindOldReasoning(ms, 3, k1)).toBe(1)
    expect(ms[1]).toEqual({ role: 'assistant', content: '' })
  })
})
