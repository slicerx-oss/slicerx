// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// OpenAI-style APIs refuse a request with more than 128 tools ("array too long ... maximum length 128"). With more
// tools than that, a turn sends the core tools, the tools the chat already called and the toolsets the turn needs, by a
// fixed priority, and says which toolsets it left out. mimir cloud's proxy takes at most 128 too, so it is held to the
// same cap. Under the cap, and on Anthropic with a key, every tool goes as before.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { createPilot, createTransportClient, DEFAULT_CONFIG, defineTool, MIMIR_CLOUD_MAX_TOOLS, type PilotTool, type Toolset } from '../src/index'
import { OPENAI_MAX_TOOLS } from '../src/provider/openai'
import { capTools, TOOLSET_PRIORITY, toolsetOf, turnNeeds } from '../src/toolsets'

const tool = (name: string, toolset: Toolset): PilotTool<never> =>
  defineTool({ name, version: '1.0.0', description: `${name} does one thing`, source: 'command', permission: 'read', toolset, input: z.object({}), run: async () => ({ summary: `${name} ran` }) }) as PilotTool<never>

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
const sse = (events: unknown[]): Uint8Array => enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''))

/** One Responses API reply: a function call, or a line of text. */
function openAiReply(step: { call?: string; text?: string }): Uint8Array {
  if (step.call) {
    return sse([
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: `c_${step.call}`, name: step.call.replaceAll('.', '__'), arguments: '{}' } },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ])
  }
  return sse([
    { type: 'response.output_text.delta', delta: step.text ?? 'Done.' },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ])
}

/** One chat completions reply with a line of text. */
function compatibleReply(): Uint8Array {
  return enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
}

/** One Messages API reply with a line of text. */
function anthropicReply(): Uint8Array {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  return enc.encode(
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) +
      ev('message_stop', { type: 'message_stop' }),
  )
}

/** The tool names a request carries, decoded, for any of the three wire formats. */
function sentTools(req: LlmHttpRequest): string[] {
  const body = JSON.parse(req.body) as { tools?: { name?: string; function?: { name: string } }[] }
  return (body.tools ?? []).map((t) => (t.name ?? t.function?.name ?? '').replaceAll('__', '.'))
}

/**
 * A provider stand-in that refuses more than 128 tools the way the OpenAI API does (a 400 the transport throws), and
 * otherwise plays the replies in order. Records every request.
 */
type Kind = 'openai' | 'openai-compatible' | 'anthropic' | 'mimir-cloud'

function provider(kind: Kind, steps: { call?: string; text?: string }[] = []): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      const n = sentTools(req).length
      // mimir cloud's proxy refuses the request as shape.ts words it
      if (kind === 'mimir-cloud' && n > 128) throw new Error('400: tools must be a list of at most 128')
      if (kind !== 'anthropic' && n > 128) throw new Error(`400: Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length ${n} instead.`)
      if (kind === 'anthropic' || kind === 'mimir-cloud') yield anthropicReply()
      else if (kind === 'openai-compatible') yield compatibleReply()
      else yield openAiReply(steps[i++] ?? { text: 'Done.' })
    },
  }
}

function setup(kind: Kind, steps: { call?: string; text?: string }[] = [], tools = manyTools()) {
  const llm = provider(kind, steps)
  const lines: string[] = []
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const model = kind === 'anthropic' || kind === 'mimir-cloud' ? 'claude-haiku-5-5' : kind === 'openai' ? 'gpt-5.6-luna' : 'qwen3:8b'
  // one model for every tier, so the log names it
  const { models: _tiers, ...base } = DEFAULT_CONFIG
  const pilot = createPilot({ host, config: { ...base, provider: kind, model, maxSteps: 4 }, policy: DEFAULT_POLICY, builtins: false, tools, log: (line) => lines.push(line) })
  return { llm, pilot, lines }
}

async function say(pilot: ReturnType<typeof createPilot>, message: string, session = 's1'): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of pilot.run(session, message)) out.push(e)
  return out
}

const reply = (events: PilotEvent[]): string => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')

describe('the tool cap on OpenAI-style providers', () => {
  it('answers with 150 tools on openai instead of the provider refusing the request', async () => {
    const { pilot, llm } = setup('openai')
    expect(pilot.tools()).toHaveLength(150)
    const events = await say(pilot, 'hello')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(reply(events)).toBe('Done.')
    expect(sentTools(llm.sent[0]!).length).toBeLessThanOrEqual(OPENAI_MAX_TOOLS)
  })

  it('openai-compatible: a local turn that calls for every toolset still sends at most 128 tools', async () => {
    const { pilot, llm } = setup('openai-compatible')
    const events = await say(pilot, 'Design a part, slice it and print it on the farm in dark mode')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    const sent = sentTools(llm.sent[0]!)
    expect(sent).toHaveLength(128)
    // a local model gets a core tool only when the surface lists it for every turn (surfaces.ts); these are not listed
    expect(sent.some((n) => n.startsWith('core.'))).toBe(false)
  })

  it('openai: sends at most 128 tools, every core tool among them', async () => {
    const { pilot, llm } = setup('openai')
    const events = await say(pilot, 'hello')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    const sent = sentTools(llm.sent[0]!)
    expect(sent.length).toBeLessThanOrEqual(128)
    for (let i = 0; i < 10; i++) expect(sent).toContain(`core.t${i}`)
    // whole toolsets in priority order: core, cad, settings, printers fill 120; fleets and theme do not fit whole,
    // pilot.load_tools takes one place, and the 7 left go to fleets, the first of them
    expect(sent).toHaveLength(128)
    expect(sent.at(-1)).toBe('pilot.load_tools')
    expect(sent.filter((n) => n.startsWith('fleet.'))).toEqual(['fleet.t0', 'fleet.t1', 'fleet.t2', 'fleet.t3', 'fleet.t4', 'fleet.t5', 'fleet.t6'])
    expect(sent.some((n) => n.startsWith('theme.'))).toBe(false)
    expect(pilot.toolCap('s1')).toEqual({ cap: 128, offered: 150, sent: 128, toolsets: ['core', 'cad', 'settings', 'printers'], leftOut: ['fleets', 'theme'], partial: [{ toolset: 'fleets', sent: 7, of: 15 }], loader: 'pilot.load_tools' })
  })

  it('keeps a tool the chat already called, even from a toolset that is left out', async () => {
    const { pilot, llm } = setup('openai', [{ call: 'theme.t3' }, { text: 'Set.' }, { text: 'Done.' }])
    const first = await say(pilot, 'hello')
    expect(first.some((e) => e.type === 'tool_call' && e.tool === 'theme.t3')).toBe(true)
    expect(sentTools(llm.sent[0]!)).not.toContain('theme.t3')
    // the step after the call, and the chat's next message, still carry it, and with it the toolset it came from
    expect(sentTools(llm.sent[1]!)).toContain('theme.t3')
    await say(pilot, 'and now?')
    const later = sentTools(llm.sent[2]!)
    expect(later).toContain('theme.t3')
    expect(later.length).toBeLessThanOrEqual(128)
    expect(later.filter((n) => n.startsWith('theme.'))).toHaveLength(15)
    expect(sentTools(llm.sent[1]!)).toEqual(later)
  })

  it('puts the toolsets a turn asks for first, trims the rest by the fixed priority and logs what it left out', async () => {
    const { pilot, llm, lines } = setup('openai')
    await say(pilot, 'Plan the fleet schedule for tonight')
    const sent = sentTools(llm.sent[0]!)
    // fleets is needed: core 10 + fleets 15 + cad 60 + settings 30 = 115; printers (135) and theme (130) do not fit
    // whole, pilot.load_tools takes one place, and the 12 left go to printers, ahead of theme
    expect(sent).toHaveLength(128)
    expect(sent.filter((n) => n.startsWith('fleet.'))).toHaveLength(15)
    expect(sent.filter((n) => n.startsWith('printer.'))).toHaveLength(12)
    expect(sent.some((n) => n.startsWith('theme.'))).toBe(false)
    expect(pilot.toolCap('s1')).toEqual({ cap: 128, offered: 150, sent: 128, toolsets: ['core', 'cad', 'settings', 'fleets'], leftOut: ['printers', 'theme'], partial: [{ toolset: 'printers', sent: 12, of: 20 }], loader: 'pilot.load_tools' })
    expect(lines).toEqual(['mimir sent 128 of 150 tools (gpt-5.6-luna on openai takes at most 128); left out: printers (12 of 20 sent), theme'])
  })

  it('logs once per run when the set does not change between steps', async () => {
    const { pilot, lines } = setup('openai', [{ call: 'core.t1' }, { text: 'Done.' }])
    await say(pilot, 'hello')
    expect(lines).toHaveLength(1)
  })
})

describe('the tool cap on mimir cloud', () => {
  it('is the limit the proxy refuses above (supabase/functions/mimir/shape.ts)', () => {
    const shape = readFileSync(new URL('../../../supabase/functions/mimir/shape.ts', import.meta.url), 'utf8')
    expect(Number(/const MAX_TOOLS = (\d+)/.exec(shape)?.[1])).toBe(MIMIR_CLOUD_MAX_TOOLS)
    expect(MIMIR_CLOUD_MAX_TOOLS).toBe(128)
    const llm = provider('mimir-cloud')
    expect(createTransportClient(llm, 'mimir-cloud').maxTools).toBe(MIMIR_CLOUD_MAX_TOOLS)
    // the same Messages API with a person's own key has no such limit
    expect(createTransportClient(llm, 'anthropic').maxTools).toBeUndefined()
  })

  it('answers with 150 tools instead of the proxy refusing the request, every core tool among them, and logs what it left out', async () => {
    const { pilot, llm, lines } = setup('mimir-cloud')
    const events = await say(pilot, 'Design a bracket and slice it')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(reply(events)).toBe('Done.')
    const sent = sentTools(llm.sent[0]!)
    expect(sent).toHaveLength(MIMIR_CLOUD_MAX_TOOLS)
    for (let i = 0; i < 10; i++) expect(sent).toContain(`core.t${i}`)
    expect(sent.filter((n) => n.startsWith('geom.t'))).toHaveLength(60)
    expect(sent.filter((n) => n.startsWith('settings.t'))).toHaveLength(30)
    expect(pilot.toolCap('s1')).toMatchObject({ cap: 128, offered: 150, sent: 128 })
    expect(lines).toEqual([expect.stringContaining('on mimir-cloud takes at most 128')])
  })
})

describe('under the cap, and on Anthropic, nothing changes', () => {
  it('openai with 120 tools sends them all, in order, and reports no cap', async () => {
    const tools = manyTools().slice(0, 120)
    const { pilot, llm, lines } = setup('openai', [], tools)
    await say(pilot, 'hello')
    expect(sentTools(llm.sent[0]!)).toEqual(pilot.tools().map((t) => t.name))
    expect(pilot.toolCap('s1')).toBeNull()
    expect(lines).toEqual([])
  })

  it('anthropic gets the same 150 tools as today', async () => {
    const { pilot, llm, lines } = setup('anthropic')
    const events = await say(pilot, 'hello')
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(sentTools(llm.sent[0]!)).toEqual(pilot.tools().map((t) => t.name))
    expect(sentTools(llm.sent[0]!)).toHaveLength(150)
    expect(pilot.toolCap('s1')).toBeNull()
    expect(lines).toEqual([])
  })
})

describe('toolsets', () => {
  it('has one fixed priority with every toolset in it once, core first', () => {
    expect(TOOLSET_PRIORITY[0]).toBe('core')
    expect(new Set(TOOLSET_PRIORITY).size).toBe(TOOLSET_PRIORITY.length)
    const all: Toolset[] = ['core', 'cad', 'mesh', 'settings', 'project', 'printers', 'fleets', 'kb', 'calibration', 'cloud', 'theme', 'local_ai', 'skills', 'cad_more']
    expect([...TOOLSET_PRIORITY].sort()).toEqual([...all].sort())
  })

  it('reads a tag first, then the name, the command and the plugin a tool came from', () => {
    const t = (name: string, extra: Partial<PilotTool> = {}) => ({ name, ...extra }) as PilotTool
    expect(toolsetOf(t('kb.search', { toolset: 'core' }))).toBe('core')
    expect(toolsetOf(t('geom.extrude'))).toBe('cad')
    expect(toolsetOf(t('design.new'))).toBe('cad')
    // a rail is asked for by name, so it loads on those words and takes no place in every capped request
    expect(toolsetOf(t('geom.rail'))).toBe('cad_more')
    for (const ask of ['Add a railing all round the deck', 'put a rail along the top', 'a fence round the tray']) expect(turnNeeds(ask).has('cad_more')).toBe(true)
    for (const ask of ['make a trail map', 'print it on Printer 2', 'the guardrails of the slicer']) expect(turnNeeds(ask).has('cad_more')).toBe(false)
    // a handrail or a guardrail is a rail too, but not a guardrail for something, a limit
    for (const ask of ['add a handrail up the stairs', 'Handrails on both sides', 'put a guardrail along the deck edge', 'guardrails round the balcony']) expect(turnNeeds(ask).has('cad_more')).toBe(true)
    for (const ask of ['what guardrails for the AI are there?', 'a railway bridge model', 'derail the plan']) expect(turnNeeds(ask).has('cad_more')).toBe(false)
    // setting the filament a part already made prints with loads on part-coloring words, never on a filament profile ask
    expect(toolsetOf(t('design.part_filament'))).toBe('cad_more')
    for (const ask of ['make the hull red', 'Put the lower hull in filament 3', 'paint the funnel black', 'set the strake to filament 2', 'make it blue', 'turn the deck white'])
      expect(turnNeeds(ask).has('cad_more'), ask).toBe(true)
    for (const ask of ['which filament should I use?', 'load filament 2', 'switch to PLA', 'is PETG better for this?', 'use set_filament on slot 2', 'add a red filament', 'make a red box', 'what filament is in slot 3?', 'Print it on Printer 2 in green PLA', 'make the hull in green PETG'])
      expect(turnNeeds(ask).has('cad_more'), ask).toBe(false)
    for (const ask of ['which filament should I use?', 'load filament 2']) expect(turnNeeds(ask).has('settings'), ask).toBe(true)
    // painting a design in filaments goes with the project's filament tools
    for (const n of ['paint.preview', 'paint.apply', 'paint.regions', 'project.add_filament']) expect(toolsetOf(t(n))).toBe('project')
    expect(toolsetOf(t('kb.filament'))).toBe('kb')
    expect(toolsetOf(t('web.lookup'))).toBe('kb')
    expect(toolsetOf(t('printer.queue'))).toBe('printers')
    expect(toolsetOf(t('check_print'))).toBe('printers')
    expect(toolsetOf(t('schedule'))).toBe('fleets')
    expect(toolsetOf(t('calibrate'))).toBe('calibration')
    expect(toolsetOf(t('settings.plan'))).toBe('settings')
    expect(toolsetOf(t('slice'))).toBe('settings')
    expect(toolsetOf(t('mesh_repair'))).toBe('mesh')
    expect(toolsetOf(t('project.info'))).toBe('project')
    expect(toolsetOf(t('pilot.ask'))).toBe('core')
    expect(toolsetOf(t('memory.recall'))).toBe('core')
    expect(toolsetOf(t('app.open_printers', { command: { id: 'open-printers', section: 'navigate' }, permission: 'read' }))).toBe('core')
    expect(toolsetOf(t('app.slice', { command: { id: 'slice', section: 'slice' }, permission: 'slice' }))).toBe('settings')
    expect(toolsetOf(t('app.plate_default', { command: { id: 'plate-default', section: 'plate' }, permission: 'slice' }))).toBe('project')
    expect(toolsetOf(t('spoolman.list_spools', { source: 'plugin', plugin: { id: 'spoolman', kind: 'app' } as unknown as NonNullable<PilotTool['plugin']> }))).toBe('printers')
  })

  it('capTools keeps core and called tools ahead of everything when they alone are over the cap', () => {
    const tools = [tool('core.a', 'core'), tool('core.b', 'core'), tool('theme.a', 'theme'), tool('core.c', 'core')]
    const out = capTools(tools, { cap: 2, needs: new Set(), called: new Set(['theme.a']) })
    expect(out.tools.map((t) => t.name)).toEqual(['core.a', 'theme.a'])
    expect(out.report).toEqual({ cap: 2, offered: 4, sent: 2, toolsets: ['theme'], leftOut: ['core'], partial: [{ toolset: 'core', sent: 1, of: 3 }], loader: null })
  })
})
