// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A cloud model over its provider's tool limit keeps a chat's toolsets from message to message: a short reply keeps what
// the last turn asked for, the list is the same on every step of a turn and on the next turn on the same topic, a
// toolset goes only when the limit forces it and never one a tool was called from in the last turn, and pilot.load_tools
// loads a toolset that was left out. Every capped request stays at the limit or under, pilot.load_tools included. A
// provider without a limit, and a local model, send what they sent before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PilotMachine, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, DEFAULT_CONFIG, defineTool, type PilotTool, type Toolset } from '../src/index'
import { capTools, LOAD_TOOLS_TOOL, LOADABLE_TOOLSETS, TOOLSET_LABELS, loadToolsTool, localTurnTools, stickyCapTools, stickyToolsets, toolsetOf, turnNeeds, type StickyToolsets, type ToolCapReport } from '../src/toolsets'

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
type Step = { call?: string; args?: unknown; text?: string; calls?: { call: string; args?: unknown }[] }

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
  if (step.calls) {
    // several tool calls in one step, one content block each
    const blocks = step.calls.map(
      (c, i) =>
        ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${i}_${c.call}`, name: c.call.replaceAll('.', '__'), input: {} } }) +
        ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.args ?? {}) } }) +
        ev('content_block_stop', { type: 'content_block_stop', index: i }),
    )
    return enc.encode(
      ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) +
        blocks.join('') +
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }) +
        ev('message_stop', { type: 'message_stop' }),
    )
  }
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

function setup(kind: Kind, steps: Step[] = [], tools = manyTools(), extra: Partial<Parameters<typeof createPilot>[0]> = {}) {
  const llm = provider(kind, steps)
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const model = kind === 'anthropic' || kind === 'mimir-cloud' ? 'claude-haiku-5-5' : kind === 'openai' ? 'gpt-5.6-luna' : 'qwen3:8b'
  const { models: _tiers, ...base } = DEFAULT_CONFIG
  const pilot = createPilot({ host, config: { ...base, provider: kind, model, maxSteps: 6 }, policy: DEFAULT_POLICY, builtins: false, tools, ...extra })
  const say = async (message: string, session = 's1'): Promise<LlmHttpRequest[]> => {
    const at = llm.sent.length
    for await (const _ of pilot.run(session, message)) void _
    return llm.sent.slice(at)
  }
  /** Runs a message and returns each tool's result as the chat shows it. */
  const results = async (message: string, signal?: AbortSignal): Promise<{ ok: boolean; summary: string }[]> => {
    const out: { ok: boolean; summary: string }[] = []
    for await (const e of pilot.run('s1', message, signal ? { signal } : {})) if (e.type === 'tool_result') out.push({ ok: e.ok, summary: e.summary })
    return out
  }
  return { llm, pilot, say, results }
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

// Print requests as people write them. Each one needs the slicing tools on a cloud model, so its first capped request
// can slice what it sends.
const PRINT_ASKS = [
  'Print bracket.stl on Bay 2',
  'print 3 copies',
  'print 3 copies on the farm',
  'print 2 copies of the bracket',
  'send to Printer 3',
  'Send to the printer',
  'go ahead and print',
  'Go ahead and print on Bay 2',
  'can you print it',
  'print the lid',
  'Print on Bay 2',
  'Print bracket on Bay 2',
  'print me a hook',
  'start the print',
  'queue it on Printer 1',
  'send the bracket to my A1',
  'please print',
  'send us the bracket to the printer',
  'Print the bracket on Printer 3',
]
// Questions about a print going, the printers or the settings, and other things to send. None of these asks for a print.
const NOT_PRINT_ASKS = [
  "How's the print on printer 3 going?",
  'print quality looks bad',
  'is my printer online',
  'Is my printer online?',
  'printer status',
  'the print failed',
  'Why did my print fail?',
  'When will the print be done?',
  'the print on Bay 2 stopped',
  'what can I print?',
  'Pause the printer',
  'how does the printer heat up',
  'print settings',
  'print speed is too slow',
  'send a bug report',
  'send my feedback',
  'send a photo from the camera',
  'send me the logs',
  'send to cloud',
  'print farm status',
  'print volume',
  'Print stuck at layer 40',
]

describe('the print request pattern', () => {
  for (const ask of PRINT_ASKS)
    it(`"${ask}" asks to print`, () => {
      const needs = turnNeeds(ask, { sliceToPrint: true })
      expect(needs.has('settings')).toBe(true)
      expect(needs.has('printers')).toBe(true)
    })
  for (const ask of NOT_PRINT_ASKS)
    it(`"${ask}" does not ask to print`, () => {
      // the print request adds nothing: the words alone decide
      expect([...turnNeeds(ask, { sliceToPrint: true })]).toEqual([...turnNeeds(ask)])
    })
})

describe('stickyCapTools', () => {
  const tools = manyTools()

  it('fills a toolset loaded this turn first, ahead of the other protected toolsets', () => {
    // cad, settings and printers were called from (120 with core); theme was loaded and must go whole
    const got = stickyCapTools(tools, {
      cap: 128,
      needs: new Set(),
      called: new Set(),
      protect: new Set(['cad', 'settings', 'printers', 'theme']),
      loaded: new Set(['theme']),
      state: state({ sets: ['core', 'cad', 'settings', 'printers'], lastCalled: new Set(['cad', 'settings', 'printers']) }),
    })
    expect(got.sets).toContain('theme')
    expect(got.tools.filter((t) => toolsetOf(t) === 'theme')).toHaveLength(15)
    expect(got.report!.partial.map((p) => p.toolset)).not.toContain('theme')
    expect(got.tools.length + 1).toBeLessThanOrEqual(128)
  })

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

const TOOLSET_PRIORITY_KEYS: Toolset[] = ['core', 'cad', 'settings', 'printers', 'fleets', 'theme']

describe('stickyCapTools ranks what a chat wants', () => {
  // core 10, two sets of 70 that cannot both go whole beside it: whichever ranks higher goes whole
  const two = [...Array.from({ length: 10 }, (_, i) => tool(`core.t${i}`, 'core')), ...Array.from({ length: 70 }, (_, i) => tool(`geom.t${i}`, 'cad')), ...Array.from({ length: 70 }, (_, i) => tool(`settings.t${i}`, 'settings'))]
  type Rank = 'loaded' | 'protect' | 'needs' | 'lastOffer' | 'lastNeeds' | 'used' | 'none'
  const ranks: Rank[] = ['loaded', 'protect', 'needs', 'lastOffer', 'lastNeeds', 'used', 'none']
  const place = (rank: Record<Toolset, Rank | undefined>) => {
    const pick = (r: Rank): Toolset[] => (['cad', 'settings'] as Toolset[]).filter((s) => rank[s] === r)
    const st = state({ lastOffer: new Set(pick('lastOffer')), lastNeeds: new Set(pick('lastNeeds')), used: new Map(pick('used').map((s) => [s, { turn: 1, calls: 1 }])) })
    return stickyCapTools(two, { cap: 128, needs: new Set(pick('needs')), called: new Set(), protect: new Set([...pick('protect'), ...pick('loaded')]), loaded: new Set(pick('loaded')), state: st })
  }

  it('goes loaded > protect > needs > lastOffer > lastNeeds > used > none, for every pair, whichever set is which', () => {
    for (let hi = 0; hi < ranks.length; hi++)
      for (let lo = hi + 1; lo < ranks.length; lo++)
        for (const [a, b] of [['cad', 'settings'], ['settings', 'cad']] as [Toolset, Toolset][]) {
          const got = place({ [a]: ranks[hi], [b]: ranks[lo] } as Record<Toolset, Rank>)
          const label = `${ranks[hi]} over ${ranks[lo]} (${a} first)`
          expect({ label, sets: got.sets.includes(a), other: got.sets.includes(b) }).toEqual({ label, sets: true, other: false })
          expect(got.tools.length + 1).toBeLessThanOrEqual(128)
        }
  })

  it('gives the same tools whatever order the state was built in', () => {
    const all = manyTools()
    const names = ['printer.t3', 'theme.t2', 'fleet.t1', 'geom.t9', 'settings.t4']
    const sets: Toolset[] = ['core', 'cad', 'settings', 'printers']
    const base = { cap: 128, needs: ['printers', 'fleets'] as Toolset[], protect: ['theme', 'cad'] as Toolset[], called: names, sets, offer: ['settings', 'theme'] as Toolset[], used: [['printers', { turn: 2, calls: 2 }], ['cad', { turn: 1, calls: 3 }], ['fleets', { turn: 2, calls: 1 }]] as [Toolset, { turn: number; calls: number }][] }
    const run = (shuffle: <X>(l: X[]) => X[]) =>
      stickyCapTools(all, {
        cap: base.cap,
        needs: new Set(shuffle([...base.needs])),
        called: new Set(shuffle([...base.called])),
        protect: new Set(shuffle([...base.protect])),
        state: state({ sets: shuffle([...base.sets]).sort((x, y) => (x === 'core' ? -1 : y === 'core' ? 1 : 0)), used: new Map(shuffle([...base.used])), lastOffer: new Set(shuffle([...base.offer])), lastNeeds: new Set(shuffle([...base.needs])) }),
      })
    const want = run((l) => l)
    let seed = 7
    const mix = <X,>(l: X[]): X[] => {
      for (let i = l.length - 1; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        const j = seed % (i + 1)
        ;[l[i], l[j]] = [l[j]!, l[i]!]
      }
      return l
    }
    // every toolset tied on rank, so only the priority order breaks the tie, never an insertion order
    const tied = (shuffle: <X>(l: X[]) => X[]) =>
      stickyCapTools(all, {
        cap: 128,
        needs: new Set(shuffle<Toolset>(['cad', 'settings', 'printers', 'fleets', 'theme'])),
        called: new Set(),
        protect: new Set(),
        state: state({ used: new Map(shuffle<[Toolset, { turn: number; calls: number }]>([['cad', { turn: 1, calls: 1 }], ['settings', { turn: 1, calls: 1 }], ['printers', { turn: 1, calls: 1 }], ['fleets', { turn: 1, calls: 1 }], ['theme', { turn: 1, calls: 1 }]])) }),
      })
    const tiedWant = tied((l) => l)
    for (let i = 0; i < 40; i++) expect(tied(mix).tools.map((t) => t.name)).toEqual(tiedWant.tools.map((t) => t.name))
    for (let i = 0; i < 40; i++) {
      const got = run(mix)
      expect(got.tools.map((t) => t.name)).toEqual(want.tools.map((t) => t.name))
      expect(got.sets).toEqual(want.sets)
      expect(got.report).toEqual(want.report)
    }
  })

  it('picks the same toolsets, and as many tools of each, when the offered tools arrive in another order', () => {
    const all = manyTools()
    const opts = { cap: 128, needs: new Set<Toolset>(['printers']), called: new Set(['theme.t2']), protect: new Set<Toolset>(), state: state({ sets: ['core', 'cad', 'settings'] }) }
    // a toolset that goes in part sends its first tools in the order given, so the order moves which ones; the counts and the whole toolsets do not move
    const shape = (got: { tools: PilotTool<never>[]; sets: Toolset[] }) => ({ sets: got.sets, count: Object.fromEntries(TOOLSET_PRIORITY_KEYS.map((k) => [k, got.tools.filter((t) => toolsetOf(t) === k).length])) })
    const want = shape(stickyCapTools(all, opts))
    for (const order of [[...all].reverse(), [...all.slice(75), ...all.slice(0, 75)]]) expect(shape(stickyCapTools(order, opts))).toEqual(want)
  })

  it('keeps core and stays at the cap when the tools called alone fill the room', () => {
    const big = [...Array.from({ length: 10 }, (_, i) => tool(`core.t${i}`, 'core')), ...Array.from({ length: 140 }, (_, i) => tool(`geom.t${i}`, 'cad'))]
    const called = new Set(Array.from({ length: 130 }, (_, i) => `geom.t${i}`))
    const got = stickyCapTools(big, { cap: 128, needs: new Set(), called, protect: new Set(['cad']), state: state({ sets: ['core', 'cad'] }) })
    const names = got.tools.map((t) => t.name)
    for (let i = 0; i < 10; i++) expect(names).toContain(`core.t${i}`)
    expect(got.tools.length + 1).toBeLessThanOrEqual(128)
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

describe('pilot.load_tools answers only what it does', () => {
  const report: ToolCapReport = { cap: 128, offered: 150, sent: 128, toolsets: ['core', 'cad', 'settings', 'printers'], leftOut: ['fleets', 'theme'], partial: [{ toolset: 'fleets', sent: 7, of: 15 }], loader: LOAD_TOOLS_TOOL }
  const ask = async (hooks: { fits?: boolean; loaded?: Toolset[]; queued?: Toolset[] }, toolset: Toolset) => {
    const asked: Toolset[] = []
    const t = loadToolsTool(report, { load: (s) => void asked.push(s), fits: () => hooks.fits ?? true, loaded: new Set(hooks.loaded ?? []), queued: () => new Set(hooks.queued ?? []) })
    const out = await t.run({ toolset } as never, {} as never)
    return { out, asked }
  }

  it('refuses a toolset that cannot go whole beside the ones just used, and loads nothing', async () => {
    const { out, asked } = await ask({ fits: false }, 'theme')
    expect(out.ok).toBe(false)
    expect(out.summary).toMatch(/no room/i)
    expect(asked).toEqual([])
  })

  it('refuses a second load of a toolset loaded this turn that still went only in part', async () => {
    const { out, asked } = await ask({ loaded: ['fleets'] }, 'fleets')
    expect(out.ok).toBe(false)
    expect(asked).toEqual([])
  })

  it('answers a load already asked for in this step without asking again', async () => {
    const { out, asked } = await ask({ queued: ['theme'] }, 'theme')
    expect(out.ok).not.toBe(false)
    expect(asked).toEqual([])
  })

  it('names each toolset in plain words in what the chat shows, never by its key', async () => {
    const keys = /\b(?:cad|kb|local_ai|fleets|settings|theme|mesh|skills|cloud|printers)\b/
    for (const toolset of LOADABLE_TOOLSETS) {
      const label = TOOLSET_LABELS[toolset]
      const t = loadToolsTool(report, { load: () => undefined, fits: () => true, loaded: new Set(), queued: () => new Set() })
      expect(t.args?.({ toolset } as never)).toBe(label)
      const answers = [
        await ask({}, toolset),
        await ask({ fits: false }, toolset),
        await ask({ loaded: [toolset] }, toolset),
        await ask({ queued: [toolset] }, toolset),
      ]
      for (const { out } of answers) {
        expect(out.summary).toContain(label)
        // a key may show only where it is also the plain word (calibration)
        expect(out.summary.replace(label, '')).not.toMatch(keys)
      }
    }
  })

  it('loads a toolset that fits', async () => {
    const { out, asked } = await ask({}, 'theme')
    expect(out.ok).not.toBe(false)
    expect(out.summary).toMatch(/^Loaded/)
    expect(asked).toEqual(['theme'])
  })

  it('in a chat, a refused load leaves the next request byte for byte as it was', async () => {
    // core, cad, settings and printers fill 120 and are called from; theme's 15 tools cannot go whole beside them
    const { llm, pilot, results } = setup('mimir-cloud', [{ call: 'geom.t1' }, { call: 'settings.t1' }, { call: 'printer.t1' }, { call: LOAD_TOOLS_TOOL, args: { toolset: 'theme' } }, { text: 'No room for those.' }])
    const got = await results('hello')
    expect(llm.sent).toHaveLength(5)
    expect(got.at(-1)).toMatchObject({ ok: false })
    expect(got.at(-1)!.summary).toMatch(/no room/i)
    expect(new Set(llm.sent.map(toolsJson)).size).toBe(1)
    expect(inSet(toolsOf(llm.sent[4]!), 'theme.')).toBe(0)
    expect(pilot.toolCap('s1')?.leftOut).toContain('theme')
  })

  it('a run that did not offer pilot.load_tools cannot call it, and the next turn sends what it would have', async () => {
    const planner = { plan: (from: PilotMachine, to: PilotMachine) => ({ from, to, changes: [], warnings: [] }) }
    const { pilot, say } = setup('mimir-cloud', [{ text: 'Hi.' }, { call: LOAD_TOOLS_TOOL, args: { toolset: 'theme' } }, { text: 'Explained.' }, { text: 'Here.' }], manyTools(), { planner })
    const one = await say('hello')
    const cap = pilot.toolCap('s1')
    const narrated: { ok: boolean; summary: string }[] = []
    const a1 = { printer: 'A1', material: 'PLA', nozzle: 0.4 }
    for await (const e of pilot.switchMachine('s1', a1, { ...a1, material: 'PETG' }, { narrate: true })) if (e.type === 'tool_result') narrated.push({ ok: e.ok, summary: e.summary })
    expect(narrated).toEqual([{ ok: false, summary: `Unknown tool ${LOAD_TOOLS_TOOL}` }])
    // the run limited to some tools leaves the chat's report alone
    expect(pilot.toolCap('s1')).toEqual(cap)
    const two = await say('and now?')
    expect(inSet(toolsOf(two[0]!), 'theme.')).toBe(0)
    expect(toolsJson(two[0]!)).toBe(toolsJson(one[0]!))
  })

  it('a load asked for in a turn canceled before its next step does not carry into the next turn', async () => {
    const stop = new AbortController()
    const halt = defineTool({ name: 'core.halt', version: '1.0.0', description: 'core.halt stops', source: 'command', permission: 'read', toolset: 'core', input: z.object({}).passthrough(), run: async () => (stop.abort(), { summary: 'stopped' }) }) as PilotTool<never>
    const { results, say, llm } = setup('mimir-cloud', [{ calls: [{ call: LOAD_TOOLS_TOOL, args: { toolset: 'theme' } }, { call: 'core.halt' }] }, { text: 'Here.' }], [...manyTools(), halt])
    const got = await results('hello', stop.signal)
    expect(got[0]).toMatchObject({ ok: true })
    expect(llm.sent).toHaveLength(1)
    const next = await say('and now?')
    expect(inSet(toolsOf(next[0]!), 'theme.')).toBe(0)
    expect(toolsJson(next[0]!)).toBe(toolsJson(llm.sent[0]!))
  })
})

describe('uncapped and local chats send what they sent before', () => {
  it('a local model asked to print gets the local pick for the printers alone: no slicing tools, no pilot.load_tools', async () => {
    for (const message of ['Print it on Bay 2', 'print 3 copies on Bay 2', 'go ahead and print']) {
      const tools = manyTools()
      const { pilot, say } = setup('openai-compatible', [{ text: 'Sure.' }], tools)
      const reqs = await say(message)
      expect(reqs.length).toBeGreaterThan(0)
      // what the runtime would send for these words without the print request: the printers toolset only
      const needs = new Set<Toolset>(['printers'])
      const want = capTools(localTurnTools('tab', tools, { needs, called: new Set() }), { cap: 128, needs, called: new Set() }).tools.map((t) => t.name)
      expect(want.some((n) => n.startsWith('settings.'))).toBe(false)
      for (const r of reqs) {
        expect(toolsOf(r)).toEqual(want)
        expect(toolsOf(r)).not.toContain(LOAD_TOOLS_TOOL)
      }
      expect(pilot.toolCap('s1')).toBeNull()
    }
  })

  it('a capped local turn reports no loader, and a capped cloud chat reports pilot.load_tools', async () => {
    const local = setup('openai-compatible', [{ text: 'One.' }])
    await local.say('Design a part, slice it and print it on the farm in dark mode')
    expect(local.pilot.toolCap('s1')).not.toBeNull()
    expect(local.pilot.toolCap('s1')!.loader).toBeNull()
    const cloud = setup('mimir-cloud', [{ text: 'Hi.' }])
    await cloud.say('hello')
    expect(cloud.pilot.toolCap('s1')!.loader).toBe(LOAD_TOOLS_TOOL)
  })

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

describe('a capped chat keeps its state per chat', () => {
  // core 10, cad 50, settings 30, printers 50, fleets 10: the printers go whole only when something asks for them
  const sets: [string, Toolset, number][] = [
    ['core.t', 'core', 10],
    ['geom.t', 'cad', 50],
    ['settings.t', 'settings', 30],
    ['printer.t', 'printers', 50],
    ['fleet.t', 'fleets', 10],
  ]
  const tools = sets.flatMap(([prefix, set, n]) => Array.from({ length: n }, (_, i) => tool(`${prefix}${i}`, set)))
  const offer = { text: 'Done. Want me to send it to the printer?' }

  it('an offer in one chat does not give another chat the printers on "yes please"', async () => {
    const { say } = setup('mimir-cloud', [offer, { text: 'Sent.' }, { text: 'Which one?' }], tools)
    await say('Design a bracket and slice it', 's1')
    const one = await say('yes please', 's1')
    expect(inSet(toolsOf(one[0]!), 'printer.')).toBe(50)
    const other = await say('yes please', 's2')
    expect(inSet(toolsOf(other[0]!), 'printer.')).toBeLessThan(50)
  })

  it('forgetRun drops the chat\'s sticky state and capped report, and leaves other chats alone', async () => {
    const { say, pilot } = setup('mimir-cloud', [offer, offer, { text: 'Sent.' }, { text: 'Sent.' }], tools)
    await say('Design a bracket and slice it', 's1')
    await say('Design a bracket and slice it', 's2')
    expect(pilot.toolCap('s1')).not.toBeNull()
    pilot.forgetRun('s1')
    expect(pilot.toolCap('s1')).toBeNull()
    expect(pilot.toolCap('s2')).not.toBeNull()
    // s1 is a new chat now: the old offer is gone, s2 still has its own
    const one = await say('yes please', 's1')
    expect(inSet(toolsOf(one[0]!), 'printer.')).toBeLessThan(50)
    const two = await say('yes please', 's2')
    expect(inSet(toolsOf(two[0]!), 'printer.')).toBe(50)
  })

  it('a chat restored on a fresh pilot starts from the messages only: what was offered, needed and called before is lost', async () => {
    const { say } = setup('mimir-cloud', [offer, { call: 'printer.t3' }, { text: 'Sent.' }, { text: 'Sent.' }], tools)
    await say('Design a bracket and slice it', 's1')
    const live = await say('yes please', 's1')
    expect(inSet(toolsOf(live[0]!), 'printer.')).toBe(50)
    // the app restores a chat as its user and reply text (pilot.resume), not its tool calls or the pilot's own notes
    const fresh = setup('mimir-cloud', [{ text: 'Sent.' }], tools)
    expect(fresh.pilot.resume).toBeDefined()
    fresh.pilot.resume?.('s1', [{ user: 'Design a bracket and slice it', reply: offer.text }])
    const restored = await fresh.say('yes please', 's1')
    expect(inSet(toolsOf(restored[0]!), 'printer.')).toBeLessThan(50)
    expect(toolsOf(restored[0]!).length).toBeLessThanOrEqual(128)
    expect(toolsOf(restored[0]!).at(-1)).toBe(LOAD_TOOLS_TOOL)
  })

  it('a reply that mentions many words does not push out what this message needs', async () => {
    const chatty = { text: 'To make the file I looked at how the quality settings look, then open the project and the theme.' }
    const { say } = setup('mimir-cloud', [chatty, { text: 'It is idle.' }], tools)
    const one = await say('hello', 's1')
    expect(inSet(toolsOf(one[0]!), 'printer.')).toBeLessThan(50)
    const two = await say('Is the printer done yet?', 's1')
    const names = toolsOf(two[0]!)
    expect(inSet(names, 'printer.')).toBe(50)
    expect(names.length).toBeLessThanOrEqual(128)
  })

  it('"no thanks" after an offer stays under the cap with core', async () => {
    const { say } = setup('mimir-cloud', [offer, { text: 'Okay.' }, { text: 'Which one?' }], tools)
    await say('Design a bracket and slice it', 's1')
    const declined = await say('no thanks', 's1')
    for (let i = 0; i < 10; i++) expect(toolsOf(declined[0]!)).toContain(`core.t${i}`)
    expect(toolsOf(declined[0]!).length).toBeLessThanOrEqual(128)
    // the decline reply is "Okay.", so it names nothing and the old offer is gone
    const later = await say('yes please', 's1')
    expect(toolsOf(later[0]!).length).toBeLessThanOrEqual(128)
  })

  it('sends the same tools whatever order the tools were registered in', async () => {
    const a = setup('mimir-cloud', [{ call: 'printer.t1' }, { text: 'Printing.' }, { text: 'Still.' }], tools)
    const b = setup('mimir-cloud', [{ call: 'printer.t1' }, { text: 'Printing.' }, { text: 'Still.' }], [...tools].reverse())
    const ra = [...(await a.say('How is the printer doing?')), ...(await a.say('Is the printer done yet?'))]
    const rb = [...(await b.say('How is the printer doing?')), ...(await b.say('Is the printer done yet?'))]
    expect(new Set(ra.map(toolsJson)).size).toBe(1)
    expect(new Set(rb.map(toolsJson)).size).toBe(1)
    // a toolset that goes in part sends its first tools in registration order, so compare the count per toolset
    const count = (names: string[]) => ['core.', 'geom.', 'settings.', 'printer.', 'fleet.'].map((p) => inSet(names, p))
    expect(count(toolsOf(rb[0]!))).toEqual(count(toolsOf(ra[0]!)))
  })

  it('a tool called that the request did not carry runs, and the next request carries it, keeps core and stays at the cap', async () => {
    const { pilot, llm } = setup('mimir-cloud', [{ call: 'theme.t3' }, { text: 'Done.' }], manyTools())
    const got: { ok: boolean; summary: string }[] = []
    for await (const e of pilot.run('s1', 'hello')) if (e.type === 'tool_result') got.push({ ok: e.ok, summary: e.summary })
    expect(got).toEqual([{ ok: true, summary: 'theme.t3 ran' }])
    const sent = llm.sent
    expect(sent).toHaveLength(2)
    expect(toolsOf(sent[0]!)).not.toContain('theme.t3')
    const next = toolsOf(sent[1]!)
    expect(next).toContain('theme.t3')
    for (let i = 0; i < 10; i++) expect(next).toContain(`core.t${i}`)
    expect(next.length).toBeLessThanOrEqual(128)
  })
})

describe('a paint ask in a capped design chat', () => {
  /**
   * A design chat over the limit, its toolsets sized so the slicing and printer tools the chat used earlier fill the room
   * the design tools leave: core, the design tools, slicing, printers, the project's six (its paint and filament tools,
   * as the app has them) and a mesh edit.
   */
  function designChat(): PilotTool<never>[] {
    // no toolset tag: the paint and filament tools go where toolsetOf puts them by name
    const named = (name: string): PilotTool<never> =>
      defineTool({ name, version: '1.0.0', description: `${name} does one thing`, source: 'command', permission: 'read', input: z.object({}).passthrough(), run: async () => ({ summary: `${name} ran` }) }) as PilotTool<never>
    const sets: [string, Toolset, number][] = [
      ['core.t', 'core', 10],
      ['geom.t', 'cad', 59],
      ['settings.t', 'settings', 30],
      ['printer.t', 'printers', 26],
      ['mesh.t', 'mesh', 1],
    ]
    return [named('design.new'), ...sets.flatMap(([prefix, set, n]) => Array.from({ length: n }, (_, i) => tool(`${prefix}${i}`, set))), ...['project.info', 'paint.preview', 'paint.apply', 'paint.regions', 'project.add_filament', 'project.set_filament'].map(named)]
  }

  /** A model that paints when it has paint.apply and otherwise asks pilot.load_tools for the toolset that holds it. */
  function painter(): LlmTransport & { sent: LlmHttpRequest[] } {
    const sent: LlmHttpRequest[] = []
    return {
      sent,
      available: async () => true,
      async *stream(req) {
        sent.push(req)
        const names = toolsOf(req)
        const body = JSON.parse(req.body) as { messages: { role: string; content: unknown }[] }
        const last = JSON.stringify(body.messages.at(-1)?.content ?? '')
        // the person's words in the newest message, after the context lines the runtime puts first
        const asked = JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '').split('User request:').at(-1) ?? ''
        let step: Step
        if (last.includes('tool_result')) step = { text: 'Done.' }
        else if (/thicker/i.test(asked)) step = { call: 'geom.t0' }
        else if (/slice/i.test(asked)) step = { calls: [{ call: 'settings.t0' }, { call: 'printer.t0' }] }
        else if (!/paint/i.test(asked)) step = { text: 'Here it is.' }
        else if (names.includes('paint.apply')) step = { call: 'paint.apply', args: {} }
        else step = { call: LOAD_TOOLS_TOOL, args: { toolset: 'project' } }
        yield wire('mimir-cloud', step)
      },
    }
  }

  it('sends the paint tools in its first request and never calls pilot.load_tools', async () => {
    const llm = painter()
    const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
    const { models: _tiers, ...base } = DEFAULT_CONFIG
    const pilot = createPilot({ host, config: { ...base, provider: 'mimir-cloud', model: 'claude-haiku-5-5', maxSteps: 6 }, policy: DEFAULT_POLICY, builtins: false, tools: designChat() })
    const say = async (message: string): Promise<{ sent: LlmHttpRequest[]; calls: string[] }> => {
      const at = llm.sent.length
      const calls: string[] = []
      for await (const e of pilot.run('s1', message)) if (e.type === 'tool_call') calls.push(e.tool)
      return { sent: llm.sent.slice(at), calls }
    }
    // the chat sliced and sent, then changed the design: the slicing and printer tools stay wanted, and fill the room
    expect((await say('Slice the plate and send it to my printer')).calls).toEqual(['settings.t0', 'printer.t0'])
    const edit = await say('Make the base thicker')
    expect(edit.calls).toEqual(['geom.t0'])
    expect(toolsOf(edit.sent[0]!)).not.toContain('paint.apply')
    const paint = await say('Paint the letters red')
    const names = toolsOf(paint.sent[0]!)
    expect(names).toEqual(expect.arrayContaining(['paint.preview', 'paint.apply', 'paint.regions', 'project.set_filament']))
    expect(names.length).toBeLessThanOrEqual(128)
    expect(paint.calls).toEqual(['paint.apply'])
    // one tool list for the whole turn
    expect(new Set(paint.sent.map(toolsJson)).size).toBe(1)
    // the next turn on the same topic sends that list again, byte for byte
    const again = await say('Paint the base blue too')
    expect(toolsJson(again.sent[0]!)).toBe(toolsJson(paint.sent.at(-1)!))
    expect(again.calls).toEqual(['paint.apply'])
  })

  it('needs the project toolset, where the paint tools are, for paint and color words', () => {
    expect(['paint.preview', 'paint.apply', 'paint.regions', 'project.set_filament'].map((name) => toolsetOf({ name }))).toEqual(['project', 'project', 'project', 'project'])
    for (const ask of ['Paint the letters red', 'make the top a different color', 'colour the base blue', 'recolor the lid']) expect(turnNeeds(ask).has('project'), ask).toBe(true)
    expect(turnNeeds('Make me a 30 mm cube').has('project')).toBe(false)
  })
})
