// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cloud model over its provider's tool limit keeps a chat's toolsets from message to message: a short reply keeps what
// the last turn asked for, the list is the same on every step of a turn and on the next turn on the same topic, a
// toolset goes only when the limit forces it and never one a tool was called from in the last turn, and pilot.load_tools
// loads a toolset that was left out. Every capped request stays at the limit or under, pilot.load_tools included. A
// provider without a limit, and a local model, send what they sent before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, DEFAULT_CONFIG, defineTool, type PilotTool, type Toolset } from '../src/index'
import { capTools, LOAD_TOOLS_TOOL, localTurnTools, stickyCapTools, stickyToolsets, toolsetOf, turnNeeds, type StickyToolsets } from '../src/toolsets'

const tool = (name: string, toolset: Toolset): PilotTool<never> =>
  defineTool({ name, version: '1.0.0', description: `${name} does one thing`, source: 'command', permission: 'read', toolset, input: z.object({}).passthrough(), run: async () => ({ summary: `${name} ran` }) }) as PilotTool<never>

/** 150 tools: core 10, cad 60, settings 30, printers 20, fleets 15, theme 15. */
function manyTools(): PilotTool<never>[] {
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

const enc = new TextEncoder()
type Step = { call?: string; args?: unknown; text?: string }

/** One reply in the provider's own wire format: a tool call, or a line of text. */
function wire(kind: Kind, step: Step): Uint8Array {
  if (kind === 'openai' || kind === 'openai-compatible') {
    const ev = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`
    if (kind === 'openai-compatible') return enc.encode(`${ev({ choices: [{ delta: { content: step.text ?? 'Done.' }, finish_reason: 'stop' }] })}data: [DONE]\n\n`)
    return enc.encode(
      (step.call
        ? ev({ type: 'response.output_item.done', item: { type: 'function_call', call_id: `c_${step.call}`, name: step.call.replaceAll('.', '__'), arguments: JSON.stringify(step.args ?? {}) } })
        : ev({ type: 'response.output_text.delta', delta: step.text ?? 'Done.' })) + ev({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    )
  }
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const block = step.call
    ? ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step.call}`, name: step.call.replaceAll('.', '__'), input: {} } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.args ?? {}) } })
    : ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text ?? 'Done.' } })
  return enc.encode(
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) +
      block +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: step.call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }) +
      ev('message_stop', { type: 'message_stop' }),
  )
}

type Kind = 'openai' | 'openai-compatible' | 'anthropic' | 'mimir-cloud'

/** A provider stand-in that refuses more than 128 tools where the real one does, and plays the replies in order. */
function provider(kind: Kind, steps: Step[]): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      if (kind !== 'anthropic' && toolsOf(req).length > 128) throw new Error('400: too many tools')
      yield wire(kind, steps[i++] ?? { text: 'Done.' })
    },
  }
}

/** A request's tools as its body carries them. */
const toolsJson = (req: LlmHttpRequest): string => JSON.stringify((JSON.parse(req.body) as { tools?: unknown[] }).tools ?? [])
function toolsOf(req: LlmHttpRequest): string[] {
  const body = JSON.parse(req.body) as { tools?: { name?: string; function?: { name: string } }[] }
  return (body.tools ?? []).map((t) => (t.name ?? t.function?.name ?? '').replaceAll('__', '.'))
}
const inSet = (names: string[], prefix: string): number => names.filter((n) => n.startsWith(prefix)).length

function setup(kind: Kind, steps: Step[] = [], tools = manyTools()) {
  const llm = provider(kind, steps)
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const model = kind === 'anthropic' || kind === 'mimir-cloud' ? 'claude-haiku-5-5' : kind === 'openai' ? 'gpt-5.6-luna' : 'qwen3:8b'
  const { models: _tiers, ...base } = DEFAULT_CONFIG
  const pilot = createPilot({ host, config: { ...base, provider: kind, model, maxSteps: 6 }, policy: DEFAULT_POLICY, builtins: false, tools })
  const say = async (message: string, session = 's1'): Promise<LlmHttpRequest[]> => {
    const at = llm.sent.length
    for await (const _ of pilot.run(session, message)) void _
    return llm.sent.slice(at)
  }
  return { llm, pilot, say }
}

const state = (over: Partial<StickyToolsets> = {}): StickyToolsets => ({ ...stickyToolsets(), ...over })

describe('a request to print needs the slicing tools on a cloud model', () => {
  for (const ask of ['Print it on Bay 2 in green PLA', 'print this on my Bay 6', 'Send it anyway', 'Want me to slice it and send it to Printer 3?'])
    it(ask, () => {
      expect([...turnNeeds(ask, { sliceToPrint: true })]).toEqual(expect.arrayContaining(['printers', 'settings']))
      // a local model's turn sets pick its own slicing tools: its needs are what they were
      expect(turnNeeds(ask).has('settings')).toBe(/slice/i.test(ask))
    })
  for (const ask of ["How's the print on printer 3 going?", 'Pause the printer', 'Is my printer online?'])
    it(`not "${ask}"`, () => expect(turnNeeds(ask, { sliceToPrint: true }).has('settings')).toBe(false))
})

describe('stickyCapTools', () => {
  const tools = manyTools()

  it('sends every tool in order with no report under the cap', () => {
    const got = stickyCapTools(tools.slice(0, 128), { cap: 128, needs: new Set(), called: new Set(), protect: new Set(), state: state() })
    expect(got.tools).toEqual(tools.slice(0, 128))
    expect(got.report).toBeNull()
  })

  it('gives the same tools, in their own order, for the same inputs', () => {
    const opts = { cap: 128, needs: new Set<Toolset>(['printers', 'fleets']), called: new Set(['theme.t2']), protect: new Set<Toolset>(), state: state({ sets: ['core', 'cad', 'settings'] }) }
    const a = stickyCapTools(tools, opts)
    const b = stickyCapTools([...tools], opts)
    expect(b.tools.map((t) => t.name)).toEqual(a.tools.map((t) => t.name))
    expect(a.tools.map((t) => tools.indexOf(t))).toEqual([...a.tools.map((t) => tools.indexOf(t))].sort((x, y) => x - y))
  })

  it('keeps the last request\'s toolsets when the new needs fit beside them', () => {
    const prev = ['core', 'cad', 'settings', 'printers'] as Toolset[]
    const got = stickyCapTools(tools, { cap: 128, needs: new Set(['printers']), called: new Set(), protect: new Set(), state: state({ sets: prev }) })
    expect(got.sets).toEqual(prev)
    expect(got.report?.leftOut).toEqual(['fleets', 'theme'])
  })

  it('takes a toolset the last turn asked for when the message names none', () => {
    // core, cad, settings and fleets were sent; mimir offered to print, and the reply is "yes please"
    const got = stickyCapTools(tools, { cap: 128, needs: new Set(), called: new Set(), protect: new Set(), state: state({ sets: ['core', 'cad', 'settings', 'fleets'], lastOffer: new Set(['printers']) }) })
    expect(got.sets).toContain('printers')
    expect(got.tools.length + 1).toBeLessThanOrEqual(128)
  })

  it('evicts only when forced, least wanted first, and never a toolset called from in the last turn', () => {
    const prev = ['core', 'cad', 'settings', 'printers'] as Toolset[]
    // printers was called from last turn; this message needs fleets and theme, 30 tools that do not fit beside the 120
    const got = stickyCapTools(tools, { cap: 128, needs: new Set(['fleets', 'theme']), called: new Set(['printer.t4']), protect: new Set(['printers']), state: state({ sets: prev, used: new Map([['printers', { turn: 1, calls: 1 }]]), turn: 2, lastCalled: new Set(['printers']) }) })
    expect(got.sets).toEqual(expect.arrayContaining(['core', 'printers', 'fleets', 'theme']))
    // settings goes before cad: nothing asked for either, and settings is later in the priority
    expect(got.sets).not.toContain('settings')
    expect(got.sets).toContain('cad')
    expect(got.tools.length + 1).toBe(128)
    // a toolset called from long ago goes before the ones the message needs
    const old = stickyCapTools(tools, { cap: 128, needs: new Set(['cad', 'settings', 'fleets', 'theme']), called: new Set(), protect: new Set(), state: state({ sets: prev, used: new Map([['printers', { turn: 1, calls: 3 }]]), turn: 9 }) })
    expect(old.sets).not.toContain('printers')
    expect(old.sets).toEqual(expect.arrayContaining(['core', 'cad', 'settings', 'fleets']))
  })

  it('stays at the cap or under for any mix of needs, calls and protected toolsets', () => {
    const sets: Toolset[] = ['cad', 'settings', 'printers', 'fleets', 'theme']
    for (let mask = 0; mask < 32; mask++)
      for (let p = 0; p < 32; p += 7) {
        const needs = new Set(sets.filter((_, i) => mask & (1 << i)))
        const protect = new Set(sets.filter((_, i) => p & (1 << i)))
        const got = stickyCapTools(tools, { cap: 128, needs, called: new Set(['theme.t1', 'fleet.t3']), protect, state: state({ sets: ['core', 'cad', 'settings', 'printers'] }) })
        expect(got.tools.length + 1).toBeLessThanOrEqual(128)
        for (let i = 0; i < 10; i++) expect(got.tools.map((t) => t.name)).toContain(`core.t${i}`)
        expect(got.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['theme.t1', 'fleet.t3']))
      }
  })
})

describe('a capped chat keeps its tools', () => {
  it('sends the same tools on every step of a turn, and on the next turn on the same topic', async () => {
    const { say } = setup('mimir-cloud', [{ call: 'printer.t1' }, { call: 'printer.t2' }, { text: 'Printing.' }, { call: 'printer.t1' }, { text: 'Still printing.' }])
    const one = await say('How is the printer doing?')
    const two = await say('Is the printer done yet?')
    expect(one).toHaveLength(3)
    expect(two).toHaveLength(2)
    for (const r of [...one, ...two]) {
      expect(toolsOf(r).length).toBeLessThanOrEqual(128)
      expect(toolsOf(r).at(-1)).toBe(LOAD_TOOLS_TOOL)
    }
    expect(new Set([...one, ...two].map(toolsJson)).size).toBe(1)
  })

  it('a "yes please" after an offer to print gets the whole printer toolset', async () => {
    // core 10, cad 50, settings 30, printers 50, fleets 10: core, cad and settings leave no room for all the printers
    const sets: [string, Toolset, number][] = [
      ['core.t', 'core', 10],
      ['geom.t', 'cad', 50],
      ['settings.t', 'settings', 30],
      ['printer.t', 'printers', 50],
      ['fleet.t', 'fleets', 10],
    ]
    const tools = sets.flatMap(([prefix, set, n]) => Array.from({ length: n }, (_, i) => tool(`${prefix}${i}`, set)))
    for (const yes of ['yes please', 'sure, go ahead']) {
      const { say } = setup('mimir-cloud', [{ text: 'Done. Want me to send it to the printer?' }, { text: 'Sent.' }], tools)
      const one = await say('Design a bracket and slice it')
      expect(inSet(toolsOf(one[0]!), 'printer.')).toBeLessThan(50)
      const two = await say(yes)
      const names = toolsOf(two[0]!)
      expect(names.length).toBeLessThanOrEqual(128)
      expect(inSet(names, 'printer.')).toBe(50)
    }
  })

  it('pilot.load_tools brings a toolset that was left out on the next step, and keeps it the turn after', async () => {
    const { pilot, say } = setup('mimir-cloud', [{ call: LOAD_TOOLS_TOOL, args: { toolset: 'theme' } }, { text: 'Loaded.' }, { text: 'Here.' }])
    const one = await say('hello')
    expect(one).toHaveLength(2)
    expect(inSet(toolsOf(one[0]!), 'theme.')).toBe(0)
    expect(inSet(toolsOf(one[1]!), 'theme.')).toBe(15)
    expect(toolsOf(one[1]!).length).toBeLessThanOrEqual(128)
    expect(pilot.toolCap('s1')?.toolsets).toContain('theme')
    const two = await say('and now?')
    expect(toolsJson(two[0]!)).toBe(toolsJson(one[1]!))
    // pilot.load_tools is not one of the offered tools the read-backs list
    expect(pilot.tools().some((t) => t.name === LOAD_TOOLS_TOOL)).toBe(false)
  })
})

describe('uncapped and local chats send what they sent before', () => {
  it('a key on the Messages API sends every tool, in order, on every step and turn, with no pilot.load_tools', async () => {
    const { pilot, say } = setup('anthropic', [{ call: 'printer.t1' }, { text: 'Printing.' }, { text: 'Hi.' }])
    const reqs = [...(await say('How is the printer doing?')), ...(await say('yes please'))]
    expect(reqs).toHaveLength(3)
    for (const r of reqs) expect(toolsOf(r)).toEqual(pilot.tools().map((t) => t.name))
    expect(pilot.toolCap('s1')).toBeNull()
  })

  it('a local model over the limit sends exactly what the local pick and the plain cap give', async () => {
    const tools = manyTools()
    const { say } = setup('openai-compatible', [{ text: 'One.' }, { text: 'Two.' }], tools)
    for (const message of ['Design a part, slice it and print it on the farm in dark mode', 'yes please']) {
      const [req] = await say(message)
      const needs = new Set<Toolset>()
      if (message.startsWith('Design')) for (const s of ['cad', 'settings', 'printers', 'fleets', 'theme'] as Toolset[]) needs.add(s)
      const local = localTurnTools('tab', tools, { needs, called: new Set() })
      const want = capTools(local, { cap: 128, needs, called: new Set() }).tools.map((t) => t.name)
      expect(toolsOf(req!)).toEqual(want)
      expect(toolsOf(req!)).not.toContain(LOAD_TOOLS_TOOL)
    }
    // every tool here is in a toolset
    expect(tools.every((t) => toolsetOf(t))).toBe(true)
  })
})
