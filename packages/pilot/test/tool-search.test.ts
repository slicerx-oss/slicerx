// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A Claude model with tool search gets the chat's whole tool catalog on every request: the same bytes in the same order
// from the first request to the last, the core loaded and every other tool deferred behind the search tool. A tool the
// app offers or withdraws mid-chat is a tool change appended to the chat, never an edit of the list. The model's own
// searches come back whole and go back unchanged. A local model and an OpenAI-style key keep their per-turn lists, and
// so does mimir cloud until its proxy has said it takes tool search: a proxy deployed before it gets what it always got.
import { readFileSync } from 'node:fs'
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PilotMachine, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, createTransportClient, DEFAULT_CONFIG, defineTool, type PilotTool, type Toolset } from '../src/index'
import { createAnthropicAdapter, TOOL_CHANGES_BETA, TOOL_SEARCH_TOOL, toolSearchModel } from '../src/provider/anthropic'
import type { LlmEvent, LlmRequest } from '../src/provider/types'
import { catalogStep, SEARCH_CORE, type OfferedTool } from '../src/tool-search'

type Obj = Record<string, unknown>

const tool = (name: string, toolset: Toolset, permission: 'read' | 'profile' = 'read'): PilotTool<never> =>
  defineTool({ name, version: '1.0.0', description: `${name} does one thing`, source: 'command', permission, toolset, input: z.object({}).passthrough(), run: async () => ({ summary: `${name} ran` }) }) as PilotTool<never>

/** The core, then 150 more: 60 design, 30 slicing (half of them changing a profile), 20 printer, 40 appearance. */
function catalog(): PilotTool<never>[] {
  const core = SEARCH_CORE.map((n) => tool(n, 'cad'))
  const more: [string, Toolset, number][] = [
    ['geom.t', 'cad', 60],
    ['settings.t', 'settings', 30],
    ['printer.t', 'printers', 20],
    ['theme.t', 'theme', 40],
  ]
  // the catalog's own order puts some core tools after others, as the registry does
  return [...more.flatMap(([prefix, set, n]) => Array.from({ length: n }, (_, i) => tool(`${prefix}${i}`, set, set === 'settings' && i % 2 ? 'profile' : 'read'))), ...core.reverse()]
}

const enc = new TextEncoder()
const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
const SEARCH_ID = 'srvtoolu_01'
/** The search block the provider streams, whole in its start event. */
const FOUND = { type: 'tool_search_tool_result', tool_use_id: SEARCH_ID, content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'geom__t7' }] } }

type Step = { text?: string; call?: string; search?: boolean }

/** One reply in the Messages API's stream: text, a tool call, or a tool search and then a call to what it found. */
function wire(step: Step): Uint8Array {
  const blocks: string[] = []
  let i = 0
  if (step.search) {
    blocks.push(
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: SEARCH_ID, name: 'tool_search_tool_bm25' } }) +
        ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{"query":"a design tool"}' } }) +
        ev('content_block_stop', { type: 'content_block_stop', index: i }),
    )
    i++
    blocks.push(ev('content_block_start', { type: 'content_block_start', index: i, content_block: FOUND }) + ev('content_block_stop', { type: 'content_block_stop', index: i }))
    i++
  }
  if (step.call) {
    blocks.push(
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `toolu_${step.call}`, name: step.call.replaceAll('.', '__'), input: {} } }) +
        ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{}' } }) +
        ev('content_block_stop', { type: 'content_block_stop', index: i }),
    )
  } else {
    blocks.push(
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }) +
        ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: step.text ?? 'Done.' } }) +
        ev('content_block_stop', { type: 'content_block_stop', index: i }),
    )
  }
  return enc.encode(
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) +
      blocks.join('') +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: step.call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }) +
      ev('message_stop', { type: 'message_stop' }),
  )
}

type Kind = 'anthropic' | 'mimir-cloud' | 'openai'

/** The event mimir cloud's proxy opens each stream with once it takes tool search (supabase/functions/mimir/handler.ts). */
const PROXY_SAYS = (() => {
  const src = readFileSync(new URL('../../../supabase/functions/mimir/handler.ts', import.meta.url), 'utf8')
  const lit = /export const TOOL_SEARCH_EVENT = ('[^']*')/.exec(src)?.[1]
  if (!lit) throw new Error('no TOOL_SEARCH_EVENT in the proxy')
  return JSON.parse(`"${lit.slice(1, -1).replaceAll('"', '\\"')}"`) as string
})()

/** A provider that plays `steps` in order; `proxy` is a mimir cloud proxy that takes tool search, so each reply opens with its event. */
function provider(steps: Step[], proxy = false): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      if (proxy) yield enc.encode(PROXY_SAYS)
      yield wire(steps[i++] ?? { text: 'Done.' })
    },
  }
}

const bodyOf = (req: LlmHttpRequest): Obj => JSON.parse(req.body) as Obj
const toolsJson = (req: LlmHttpRequest): string => JSON.stringify(bodyOf(req)['tools'] ?? [])
const toolsOf = (req: LlmHttpRequest): Obj[] => (bodyOf(req)['tools'] as Obj[] | undefined) ?? []
const messagesOf = (req: LlmHttpRequest): Obj[] => bodyOf(req)['messages'] as Obj[]
const systemMessages = (req: LlmHttpRequest): Obj[] => messagesOf(req).filter((m) => m['role'] === 'system')
const name = (t: Obj): string => String(t['name']).replaceAll('__', '.')

/**
 * A chat runtime on `kind`. On mimir cloud the proxy takes tool search unless `proxy` is 'old', and a first chat has
 * heard it say so (`warm`, its requests left out of `sent`); `warm: false` leaves that out.
 */
async function setup(kind: Kind, steps: Step[], model = 'claude-haiku-5-5', extra: Partial<Parameters<typeof createPilot>[0]> = {}, opts: { proxy?: 'old' | 'new'; warm?: boolean } = {}) {
  const cloud = kind === 'mimir-cloud'
  const proxy = cloud && opts.proxy !== 'old'
  const warm = proxy && opts.warm !== false
  const llm = provider(warm ? [{ text: 'Hi.' }, ...steps] : steps, proxy)
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const { models: _tiers, ...base } = DEFAULT_CONFIG
  const pilot = createPilot({ host, config: { ...base, provider: kind, model, maxSteps: 6 }, policy: DEFAULT_POLICY, builtins: false, tools: catalog(), ...extra })
  const say = async (message: string, session = 's1'): Promise<LlmHttpRequest[]> => {
    const at = llm.sent.length
    for await (const _ of pilot.run(session, message)) void _
    return llm.sent.slice(at)
  }
  if (warm) {
    await say('hello', 'warm')
    llm.sent.splice(0)
  }
  return { llm, pilot, say }
}

describe('which models search their tools', () => {
  it('takes the models with tool search and mid-chat tool changes, and no other', () => {
    for (const m of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-opus-4-8']) expect(toolSearchModel(m), m).toBe(true)
    // Sonnet 5 takes no system message mid-chat; the older models and other providers have neither
    for (const m of ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5.6-luna', 'qwen3:8b', 'pinned-model']) expect(toolSearchModel(m), m).toBe(false)
  })
})

describe('a chat catalog', () => {
  const offer = (names: string[], made: string[] = []): OfferedTool[] =>
    names.map((n) => ({ name: n, def: () => (made.push(n), { name: n, description: `${n} v${made.length}`, parameters: { type: 'object', properties: {} } }) }))

  it('declares the core first, loaded, in its order, and the rest deferred in their own', () => {
    const { catalog: c, add, remove } = catalogStep(undefined, offer(['b', 'geom.measure', 'geom.extrude', 'a', 'design.look']))
    expect(c.defs.map((d) => [d.name, d.deferred === true])).toEqual([['design.look', false], ['geom.extrude', false], ['b', true], ['geom.measure', true], ['a', true]])
    expect([add, remove]).toEqual([[], []])
  })

  it('never builds or changes a definition it holds, appends new tools deferred, and says what came and went', () => {
    const made: string[] = []
    const one = catalogStep(undefined, offer(['design.look', 'a', 'b'], made)).catalog
    const two = catalogStep(one, offer(['design.look', 'b', 'c'], made))
    expect(made).toEqual(['design.look', 'a', 'b', 'c'])
    expect(two.catalog.defs.map((d) => d.name)).toEqual(['design.look', 'a', 'b', 'c'])
    expect(two.catalog.defs.slice(0, 3)).toEqual(one.defs)
    expect(two.catalog.defs[3]!.deferred).toBe(true)
    expect([two.add, two.remove]).toEqual([['c'], ['a']])
    // a tool withdrawn and offered again comes back by name, its definition as first sent
    const three = catalogStep(two.catalog, offer(['design.look', 'a', 'b', 'c'], made))
    expect([three.add, three.remove]).toEqual([['a'], []])
    expect(three.catalog.defs).toEqual(two.catalog.defs)
    expect(made).toHaveLength(4)
    // and the catalog it was given is left as it was
    expect([...one.live]).toEqual(['design.look', 'a', 'b'])
  })
})

describe('a tool search request', () => {
  const adapter = createAnthropicAdapter()
  const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
    model: 'claude-haiku-5-5',
    messages: [
      { role: 'system', content: 'You are mimir.' },
      { role: 'user', content: 'a cube' },
      { role: 'tools', content: '', add: ['geom.t1'], remove: ['theme.t2', 'theme.t3'] },
    ],
    tools: [
      { name: 'design.look', description: 'look', parameters: { type: 'object', properties: {} } },
      { name: 'geom.t1', description: 't1', parameters: { type: 'object', properties: {} }, deferred: true },
    ],
    toolSearch: true,
    ...over,
  })

  it('defers what is deferred, caches the last tool that loads, adds the search tool and sends the tool changes', () => {
    const http = adapter.build(req())
    const body = JSON.parse(http.body) as Obj
    expect(body['tools']).toEqual([
      { name: 'design__look', description: 'look', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
      { name: 'geom__t1', description: 't1', input_schema: { type: 'object', properties: {} }, defer_loading: true },
      TOOL_SEARCH_TOOL,
    ])
    expect((body['messages'] as Obj[])[1]).toEqual({
      role: 'system',
      content: [
        { type: 'tool_addition', tool: { type: 'tool_reference', name: 'geom__t1' } },
        { type: 'tool_removal', tool: { type: 'tool_reference', name: 'theme__t2' } },
        { type: 'tool_removal', tool: { type: 'tool_reference', name: 'theme__t3' } },
      ],
    })
    expect(http.headers['anthropic-beta']).toBe(TOOL_CHANGES_BETA)
    // with no tool change in the chat, no beta
    expect(adapter.build(req({ messages: [{ role: 'user', content: 'a cube' }] })).headers['anthropic-beta']).toBeUndefined()
  })

  it('without tool search sends neither the deferral, the search tool nor the tool changes', () => {
    const http = adapter.build(req({ toolSearch: false }))
    const body = JSON.parse(http.body) as Obj
    expect((body['tools'] as Obj[]).map((t) => [t['name'], 'defer_loading' in t])).toEqual([['design__look', false], ['geom__t1', false]])
    expect((body['messages'] as Obj[]).map((m) => m['role'])).toEqual(['user'])
    expect(http.headers['anthropic-beta']).toBeUndefined()
  })

  it('keeps a streamed tool search whole and sends it back unchanged', async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield wire({ search: true, call: 'geom.t7' })
    }
    const events: LlmEvent[] = []
    for await (const e of adapter.parse(chunks())) events.push(e)
    const done = events.find((e) => e.type === 'done') as Extract<LlmEvent, { type: 'done' }>
    expect(done.raw?.slice(0, 2)).toEqual([{ type: 'server_tool_use', id: SEARCH_ID, name: 'tool_search_tool_bm25', input: { query: 'a design tool' } }, FOUND])
    // the call to the tool the search found runs like any other
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', call: { id: 'toolu_geom.t7', name: 'geom.t7', arguments: '{}' } }])
    const next = JSON.parse(adapter.build(req({ messages: [{ role: 'user', content: 'a cube' }, { role: 'assistant', content: '', raw: done.raw! }] })).body) as Obj
    expect((next['messages'] as Obj[])[1]!['content']).toEqual(done.raw)
  })
})

describe('a chat on a model with tool search', () => {
  for (const kind of ['anthropic', 'mimir-cloud'] as const) {
    it(`sends the same whole catalog on every request, the core loaded and the rest deferred (${kind})`, async () => {
      const { llm, say } = await setup(kind, [{ call: 'geom.extrude' }, { search: true, call: 'geom.t7' }, { text: 'A cube.' }, { call: 'theme.t3' }, { text: 'Dark now.' }])
      await say('a 20 mm cube')
      await say('switch to dark mode')
      expect(llm.sent).toHaveLength(5)
      expect(new Set(llm.sent.map(toolsJson)).size).toBe(1)
      const tools = toolsOf(llm.sent[0]!)
      expect(tools).toHaveLength(SEARCH_CORE.length + 150 + 1)
      const loaded = tools.filter((t) => t['defer_loading'] !== true)
      expect(loaded.map(name)).toEqual([...SEARCH_CORE, 'tool_search_tool_bm25'])
      expect(loaded.at(-1)).toEqual(TOOL_SEARCH_TOOL)
      expect(tools.filter((t) => t['cache_control']).map(name)).toEqual(['paint.apply'])
      // nothing changed what the chat is offered, so no tool change and no beta
      expect(llm.sent.flatMap(systemMessages)).toEqual([])
      expect(llm.sent.map((r) => r.headers['anthropic-beta'])).toEqual(Array(5).fill(undefined))
      // the search and what it found go back as they came, and the found tool ran
      const replay = messagesOf(llm.sent[2]!).find((m) => m['role'] === 'assistant' && JSON.stringify(m).includes('tool_search_tool_result'))
      expect((replay!['content'] as Obj[])[1]).toEqual(FOUND)
      expect(JSON.stringify(messagesOf(llm.sent[2]!))).toContain('geom.t7 ran')
    })
  }

  it('withdraws the tools a read-only run may not use and offers them again after, never touching the list', async () => {
    const planner = { plan: (from: PilotMachine, to: PilotMachine) => ({ from, to, changes: [], warnings: [] }) }
    const { llm, pilot, say } = await setup('mimir-cloud', [{ text: 'Hi.' }, { call: 'settings.t1' }, { text: 'Explained.' }, { text: 'Here.' }], 'claude-haiku-5-5', { planner })
    await say('hello')
    const a1 = { printer: 'A1', material: 'PLA', nozzle: 0.4 }
    const results: { ok: boolean; summary: string }[] = []
    for await (const e of pilot.switchMachine('s1', a1, { ...a1, material: 'PETG' }, { narrate: true })) if (e.type === 'tool_result') results.push({ ok: e.ok, summary: e.summary })
    // the withdrawn tool is unknown to the run, as a tool it was never sent would be
    expect(results).toEqual([{ ok: false, summary: 'Unknown tool settings.t1' }])
    await say('and now?')
    expect(llm.sent).toHaveLength(4)
    expect(new Set(llm.sent.map(toolsJson)).size).toBe(1)
    const writing = Array.from({ length: 15 }, (_, i) => `settings__t${2 * i + 1}`)
    const change = (kind: string) => writing.map((n) => ({ type: kind, tool: { type: 'tool_reference', name: n } }))
    // the read-only run's first request ends on the removal; the next turn's opens with the addition, the removal kept
    expect(messagesOf(llm.sent[1]!).at(-1)).toEqual({ role: 'system', content: change('tool_removal') })
    const last = messagesOf(llm.sent[3]!)
    expect(last.filter((m) => m['role'] === 'system')).toEqual([{ role: 'system', content: change('tool_removal') }, { role: 'system', content: change('tool_addition') }])
    expect(last.at(-1)).toEqual({ role: 'system', content: change('tool_addition') })
    // every message an earlier request sent goes again as it was, so the cache holds past the changes
    for (const [a, b] of [[0, 1], [1, 2], [2, 3]] as const) {
      const before = messagesOf(llm.sent[a]!)
      expect(messagesOf(llm.sent[b]!).slice(0, before.length), `request ${b}`).toEqual(before)
    }
    expect(llm.sent.slice(1).map((r) => r.headers['anthropic-beta'])).toEqual(Array(3).fill(TOOL_CHANGES_BETA))
    // each change follows the person's words or a tool's answer and comes before the reply
    for (const r of llm.sent) {
      const m = messagesOf(r)
      m.forEach((x, i) => {
        if (x['role'] !== 'system') return
        expect(m[i - 1]!['role']).toBe('user')
        if (i + 1 < m.length) expect(m[i + 1]!['role']).toBe('assistant')
      })
    }
  })

  it('takes back a tool change no reply followed', async () => {
    const planner = { plan: (from: PilotMachine, to: PilotMachine) => ({ from, to, changes: [], warnings: [] }) }
    const llm = provider([{ text: 'Hi.' }, { text: 'Hi.' }, { text: 'Fine.' }], true)
    let fail = false
    const flaky: LlmTransport = {
      available: async () => true,
      async *stream(req, signal) {
        if (fail) {
          llm.sent.push(req)
          throw new Error('500: provider error')
        }
        yield* llm.stream(req, signal)
      },
    }
    const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: flaky }
    const { models: _tiers, ...base } = DEFAULT_CONFIG
    const pilot = createPilot({ host, config: { ...base, provider: 'mimir-cloud', model: 'claude-haiku-5-5', maxSteps: 6 }, policy: DEFAULT_POLICY, builtins: false, tools: catalog(), planner })
    // a first chat hears the proxy say it takes tool search
    for await (const _ of pilot.run('warm', 'hello')) void _
    llm.sent.splice(0)
    for await (const _ of pilot.run('s1', 'hello')) void _
    fail = true
    const a1 = { printer: 'A1', material: 'PLA', nozzle: 0.4 }
    for await (const _ of pilot.switchMachine('s1', a1, { ...a1, material: 'PETG' }, { narrate: true })) void _
    fail = false
    for await (const _ of pilot.run('s1', 'and now?')) void _
    const last = messagesOf(llm.sent.at(-1)!)
    // the removal the failed request carried is gone, and nothing was withdrawn, so nothing is added back
    expect(last.filter((m) => m['role'] === 'system')).toEqual([])
    expect(last.map((m) => m['role'])).toEqual(['user', 'assistant', 'user', 'user'])
  })

  it('keeps the per-turn list on a model without tool search and on an OpenAI-style key', async () => {
    for (const [kind, model] of [['mimir-cloud', 'claude-haiku-4-5'], ['openai', 'gpt-5.6-luna']] as const) {
      const { llm, say } = await setup(kind, [{ text: 'Hi.' }], model)
      await say('hello')
      const tools = toolsOf(llm.sent[0]!)
      expect(tools.length, kind).toBeLessThanOrEqual(128)
      expect(tools.some((t) => 'defer_loading' in t || t['type'] === TOOL_SEARCH_TOOL.type), kind).toBe(false)
    }
  })
})

describe('mimir cloud before and after its proxy takes tool search', () => {
  const capped = (r: LlmHttpRequest): boolean => toolsOf(r).length <= 128 && !toolsOf(r).some((t) => 'defer_loading' in t || t['type'] === TOOL_SEARCH_TOOL.type) && systemMessages(r).length === 0 && r.headers['anthropic-beta'] === undefined

  it('on a proxy that never said so sends the per-turn pick: no deferral, no search tool and no tool changes', async () => {
    const planner = { plan: (from: PilotMachine, to: PilotMachine) => ({ from, to, changes: [], warnings: [] }) }
    const { llm, pilot, say } = await setup('mimir-cloud', [{ text: 'Hi.' }, { call: 'settings.t1' }, { text: 'Explained.' }, { text: 'Here.' }], 'claude-haiku-5-5', { planner }, { proxy: 'old' })
    await say('hello')
    // a read-only run, which on the catalog would withdraw tools by a tool change
    const a1 = { printer: 'A1', material: 'PLA', nozzle: 0.4 }
    for await (const _ of pilot.switchMachine('s1', a1, { ...a1, material: 'PETG' }, { narrate: true })) void _
    await say('and now?')
    await say('a new chat', 's2')
    expect(pilot.tools().length).toBeGreaterThan(128)
    expect(llm.sent.length).toBeGreaterThanOrEqual(4)
    expect(llm.sent.filter((r) => !capped(r)).map((r) => toolsOf(r).length)).toEqual([])
  })

  it('keeps the pick for the whole chat that first hears it, and sends the catalog from the next chat on', async () => {
    const { llm, say } = await setup('mimir-cloud', [{ text: 'Hi.' }, { text: 'Still here.' }, { text: 'New chat.' }], 'claude-haiku-5-5', {}, { warm: false })
    const first = [...(await say('hello')), ...(await say('and now?'))]
    expect(first).toHaveLength(2)
    expect(first.every(capped)).toBe(true)
    const next = await say('a new chat', 's2')
    const tools = toolsOf(next[0]!)
    expect(tools).toHaveLength(SEARCH_CORE.length + 150 + 1)
    expect(tools.filter((t) => t['defer_loading'] !== true).map(name)).toEqual([...SEARCH_CORE, 'tool_search_tool_bm25'])
    expect(llm.sent).toHaveLength(3)
  })

  it('hears the event from mimir cloud only, keeps it per transport, and passes it on no further', async () => {
    const said = (): LlmTransport & { sent: LlmHttpRequest[] } => provider([{ text: 'Hi.' }, { text: 'Hi.' }], true)
    const ask: LlmRequest = { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hello' }], tools: [] }
    const events = async (c: ReturnType<typeof createTransportClient>): Promise<string[]> => {
      const out: string[] = []
      for await (const e of c.stream(ask)) out.push(e.type)
      return out
    }
    const llm = said()
    // a key on the Messages API takes tool search without the event, and an event there changes nothing
    const direct = createTransportClient(llm, 'anthropic')
    const cloud = createTransportClient(llm, 'mimir-cloud')
    expect([direct.toolSearch, cloud.toolSearch]).toEqual([true, false])
    expect(await events(direct)).not.toContain('tool_search')
    expect(cloud.toolSearch).toBe(false)
    expect(await events(cloud)).toEqual(['text', 'usage', 'done'])
    expect(cloud.toolSearch).toBe(true)
    // a runtime made again on the same transport knows at once; another transport, or an OpenAI-style key, does not
    expect(createTransportClient(llm, 'mimir-cloud').toolSearch).toBe(true)
    expect(createTransportClient(said(), 'mimir-cloud').toolSearch).toBe(false)
    expect(createTransportClient(llm, 'openai').toolSearch).toBe(false)
    // the adapter reads it, and only the proxy's own event with its flag set
    const parsed: LlmEvent[] = []
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield enc.encode(PROXY_SAYS + ev('mimir', { type: 'mimir', tool_search: false }))
    }
    for await (const e of createAnthropicAdapter().parse(chunks())) parsed.push(e)
    expect(parsed.filter((e) => e.type === 'tool_search')).toEqual([{ type: 'tool_search' }])
  })
})
