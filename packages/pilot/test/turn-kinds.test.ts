// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A capped cloud chat picks its tools by what the turn is for: building a part keeps every design tool, slicing keeps the
// slicing tools, running a printer keeps every printer tool with send. Every turn of a kind keeps the printer safety
// tools (list, status, pause, cancel), which take the printer as an argument, so they stay four whatever the fleet's
// size. A turn of the same kind as the last sends the same list byte for byte, and while an approved plan is being built
// every turn is a design turn. A mixed turn picks as before kinds, with the four safety tools always in.
import { DEFAULT_POLICY, type ApprovalHost, type LlmHttpRequest, type LlmTransport, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPilot, DEFAULT_CONFIG, READ_ONLY, defineTool, type PilotTool, type Toolset } from '../src/index'
import { LOAD_TOOLS_TOOL, MAX_PINNED, pinnedFor, SAFETY_TOOLS, SEND_TOOLS, stickyCapTools, stickyToolsets, turnKind, turnNeeds, type StickyToolsets, type TurnKind } from '../src/toolsets'

const tool = (name: string, toolset: Toolset, run: () => { summary: string; output?: unknown } = () => ({ summary: `${name} ran` })): PilotTool<never> =>
  defineTool({ name, version: '1.0.0', description: `${name} does one thing`, source: 'command', permission: 'read', hints: READ_ONLY, toolset, input: z.object({}).passthrough(), run: async () => run() }) as PilotTool<never>

const PRINTER_BASE = ['diagnose', 'check_print', 'printer_setup', 'printer_add', 'printer.history', 'printer.resume', ...SEND_TOOLS, ...SAFETY_TOOLS]

/**
 * The app's worst case in shape (packages/app/test/mimir-sticky-toolsets.test.ts measured 167 tools at 12 printers):
 * core 18, design 40, slicing 23, project 8, kb 10, the printers' base tools, a send and a pause per printer, and 24
 * connector tools. The per-printer tools come first in the list, so a fill in list order reaches them before the
 * generic ones.
 */
function fleetTools(printers: number, design?: () => { summary: string; output?: unknown }): PilotTool<never>[] {
  const per = Array.from({ length: printers }, (_, i) => [tool(`app.send_p${i + 1}`, 'printers'), tool(`app.pause_p${i + 1}`, 'printers')]).flat()
  const connectors = Array.from({ length: 24 }, (_, i) => tool(`connector.t${i}`, 'printers'))
  return [
    ...Array.from({ length: 18 }, (_, i) => tool(`core.t${i}`, 'core')),
    ...(design ? [tool('design.plan', 'cad', design)] : []),
    ...Array.from({ length: design ? 39 : 40 }, (_, i) => tool(`geom.t${i}`, 'cad')),
    ...Array.from({ length: 23 }, (_, i) => tool(`settings.t${i}`, 'settings')),
    ...Array.from({ length: 8 }, (_, i) => tool(`project.t${i}`, 'project')),
    ...Array.from({ length: 10 }, (_, i) => tool(`kb.t${i}`, 'kb')),
    ...per,
    ...connectors,
    ...PRINTER_BASE.map((n) => tool(n, 'printers')),
  ]
}

const enc = new TextEncoder()
type Step = { call?: string; args?: unknown; text?: string }

/** One mimir cloud reply in the Messages API's wire format: a tool call, or a line of text. */
function wire(step: Step): Uint8Array {
  const ev = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
  const block = step.call
    ? ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step.call}_${Math.random().toString(36).slice(2)}`, name: step.call.replaceAll('.', '__'), input: {} } }) +
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

/** mimir cloud's proxy: more than 128 tools is refused; the replies play in order. */
function provider(steps: Step[]): LlmTransport & { sent: LlmHttpRequest[] } {
  const sent: LlmHttpRequest[] = []
  let i = 0
  return {
    sent,
    available: async () => true,
    async *stream(req) {
      sent.push(req)
      if (toolsOf(req).length > 128) throw new Error('400: too many tools')
      yield wire(steps[i++] ?? { text: 'Done.' })
    },
  }
}

const toolsJson = (req: LlmHttpRequest): string => JSON.stringify((JSON.parse(req.body) as { tools?: unknown[] }).tools ?? [])
const toolsOf = (req: LlmHttpRequest): string[] => ((JSON.parse(req.body) as { tools?: { name?: string }[] }).tools ?? []).map((t) => String(t.name ?? '').replaceAll('__', '.'))

function chat(steps: Step[], tools: PilotTool<never>[], designs = false) {
  const llm = provider(steps)
  const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm }
  const { models: _tiers, ...base } = DEFAULT_CONFIG
  // the design tab: the runtime reads it from design.new being offered
  const offered = designs ? [...tools, tool('design.new', 'cad')] : tools
  const pilot = createPilot({ host, config: { ...base, provider: 'mimir-cloud', model: 'claude-haiku-5-5', maxSteps: 6 }, policy: DEFAULT_POLICY, builtins: false, tools: offered })
  const say = async (message: string): Promise<LlmHttpRequest[]> => {
    const at = llm.sent.length
    for await (const _ of pilot.run('s1', message)) void _
    return llm.sent.slice(at)
  }
  return { llm, pilot, say }
}

const kindOf = (message: string, opts: Parameters<typeof turnKind>[1] = {}): TurnKind => turnKind(turnNeeds(message, { sliceToPrint: true }), opts)

describe('turnKind', () => {
  it('reads what a message is for', () => {
    expect(kindOf('Make a coat hook for a 6 mm screw')).toBe('design')
    expect(kindOf('Use 20% infill')).toBe('slicing')
    expect(kindOf('Pause Printer 30')).toBe('printer')
    expect(kindOf('pause it')).toBe('printer')
    // printing a part needs slicing and a printer: mixed, as before kinds
    expect(kindOf('Print it on Printer 2 in green PLA')).toBe('mixed')
    expect(kindOf('Design a bracket and slice it')).toBe('mixed')
    expect(kindOf('hello')).toBe('mixed')
  })

  it('takes the design tab for a message that asks for none, and a build over any words', () => {
    expect(kindOf('hello', { designs: true })).toBe('design')
    expect(kindOf('Pause Printer 3', { building: true })).toBe('design')
    expect(kindOf('slice it with 20% infill', { building: true, designs: true })).toBe('design')
  })

  it('gives a short reply the kind of what the last reply offered', () => {
    expect(kindOf('yes please', { offer: new Set<Toolset>(['printers']), designs: true })).toBe('printer')
    expect(kindOf('yes please', { offer: new Set<Toolset>(['printers', 'settings']), designs: true })).toBe('mixed')
  })
})

describe('the pinned tools', () => {
  it('are a fixed few whatever the fleet: the safety tools, and send on a printer turn', () => {
    expect(MAX_PINNED).toBe(6)
    expect([...pinnedFor('design')]).toEqual(SAFETY_TOOLS)
    expect([...pinnedFor('slicing')]).toEqual(SAFETY_TOOLS)
    expect([...pinnedFor('printer')]).toEqual([...SAFETY_TOOLS, ...SEND_TOOLS])
    expect([...pinnedFor('mixed')]).toEqual(SAFETY_TOOLS)
    expect(pinnedFor(undefined).size).toBe(0)
  })
})

const pick = (tools: PilotTool<never>[], o: { needs?: Toolset[]; kind?: TurnKind; state?: StickyToolsets } = {}) =>
  stickyCapTools(tools, { cap: 128, needs: new Set(o.needs ?? []), called: new Set(), protect: new Set(), state: o.state ?? stickyToolsets(), ...(o.kind ? { kind: o.kind } : {}) })

describe('stickyCapTools by kind', () => {
  for (const printers of [12, 32]) {
    it(`a design turn at ${printers} printers keeps every design tool and the safety tools, at 127 or under`, () => {
      const tools = fleetTools(printers)
      const r = pick(tools, { needs: ['cad'], kind: 'design' })
      const names = r.tools.map((t) => t.name)
      expect(names.length).toBeLessThanOrEqual(127)
      expect(names.filter((n) => n.startsWith('geom.'))).toHaveLength(40)
      expect(names).toEqual(expect.arrayContaining([...SAFETY_TOOLS]))
      expect(r.sets).toContain('cad')
    })

    it(`a printer turn at ${printers} printers keeps send and the safety tools, at 127 or under`, () => {
      const r = pick(fleetTools(printers), { needs: ['printers'], kind: 'printer' })
      const names = r.tools.map((t) => t.name)
      expect(names.length).toBeLessThanOrEqual(127)
      expect(names).toEqual(expect.arrayContaining([...SAFETY_TOOLS, ...SEND_TOOLS]))
    })
  }

  it('without the pins the 32 printer fill in list order would leave the generic pause out', () => {
    // the before: no kind, so no pins; the per-printer tools come first in the list
    const names = pick(fleetTools(32), { needs: ['cad'] }).tools.map((t) => t.name)
    expect(names).not.toContain('printer.pause')
  })

  it('a mixed turn at 32 printers picks what no kind picks, plus the four safety tools, for any needs and state', () => {
    const tools = fleetTools(32)
    const all: Toolset[] = ['cad', 'settings', 'printers', 'project', 'kb']
    for (let mask = 0; mask < 32; mask++) {
      const needs = all.filter((_, i) => mask & (1 << i))
      const state = { ...stickyToolsets(), sets: needs.slice(1), lastOffer: new Set(needs.slice(0, 1)) }
      const before = pick(tools, { needs, state }).tools.map((t) => t.name)
      const mixed = pick(tools, { needs, state, kind: 'mixed' }).tools.map((t) => t.name)
      expect(mixed.length).toBeLessThanOrEqual(127)
      // the safety tools are always in
      expect(mixed).toEqual(expect.arrayContaining([...SAFETY_TOOLS]))
      // and nothing else changes: every other tool was in the list before, and the safety tools that were not take
      // the room of as many of the last tools filled, no more
      expect(mixed.filter((n) => !SAFETY_TOOLS.includes(n)).every((n) => before.includes(n))).toBe(true)
      const added = SAFETY_TOOLS.filter((n) => !before.includes(n)).length
      expect(before.filter((n) => !mixed.includes(n)).length).toBeLessThanOrEqual(added)
    }
  })

  it('"Print it on Printer 30" at 32 printers is mixed and keeps pause', () => {
    const needs = turnNeeds('Print it on Printer 30', { sliceToPrint: true })
    expect(turnKind(turnNeeds('Print it on Printer 30', { sliceToPrint: true }))).toBe('mixed')
    const names = pick(fleetTools(32), { needs: [...needs, 'cad'], kind: 'mixed' }).tools.map((t) => t.name)
    expect(names.length).toBeLessThanOrEqual(127)
    expect(names).toEqual(expect.arrayContaining([...SAFETY_TOOLS]))
  })
})

describe('a capped chat by kind', () => {
  it('"Pause Printer 30" at 32 printers carries a pause that can pause it', async () => {
    const { say } = chat([{ text: 'Pausing.' }], fleetTools(32))
    const names = toolsOf((await say('Pause Printer 30'))[0]!)
    expect(names.length).toBeLessThanOrEqual(128)
    // the generic pause takes any printer's id
    expect(names).toContain('printer.pause')
    expect(names).toContain('printer.list')
  })

  it('a design turn, then "pause it": pause is there without a pilot.load_tools step', async () => {
    const { say } = chat([{ text: 'Built.' }, { call: 'printer.pause', args: {} }, { text: 'Paused.' }], fleetTools(32))
    const one = await say('Make a wall hook for a 6 mm screw')
    expect(toolsOf(one[0]!)).toContain('printer.pause')
    const two = await say('pause it')
    expect(toolsOf(two[0]!)).toContain('printer.pause')
    for (const r of two) expect(toolsOf(r).length).toBeLessThanOrEqual(128)
    // the pause was called first: no load step before it
    expect(two).toHaveLength(2)
  })

  it('two design turns in a row send the same list, byte for byte, in the same order', async () => {
    const { say } = chat([{ text: 'Built.' }, { text: 'Built too.' }], fleetTools(12))
    const one = await say('Make a wall hook for a 6 mm screw')
    const two = await say('Now draw a bracket with a 5 mm hole and a chamfer')
    expect(toolsJson(two[0]!)).toBe(toolsJson(one[0]!))
  })

  it('two printer turns in a row send the same list, byte for byte', async () => {
    const { say } = chat([{ text: 'Paused.' }, { text: 'Resumed.' }], fleetTools(12))
    const one = await say('Pause Printer 3')
    const two = await say('Resume the print on Printer 3, and show the bed camera')
    expect(toolsJson(two[0]!)).toBe(toolsJson(one[0]!))
  })

  it('while an approved plan is built, a follow-up about slicing or printers keeps the build\'s list', async () => {
    const plan = () => ({ summary: 'Approved as shown', output: { planId: 'plan_1', accepted: true } })
    const { say } = chat(
      [{ call: 'design.plan', args: { part: 'Hook', features: [{ name: 'hook' }] } }, { text: 'Planned.' }, { text: 'Going on.' }, ...Array.from({ length: 6 }, () => ({ text: 'Noted.' }))],
      fleetTools(12, plan),
      true,
    )
    const one = await say('Make a wall hook for a 6 mm screw')
    const built = toolsJson(one.at(-1)!)
    for (const follow of ['slice it with 20% infill when it is done', 'and send it to Printer 3 after']) {
      const next = await say(follow)
      expect(toolsJson(next[0]!)).toBe(built)
      expect(toolsOf(next[0]!)).toEqual(expect.arrayContaining([...SAFETY_TOOLS]))
    }
  })

  it('a wrong guess costs one pilot.load_tools step', async () => {
    // "hello" on the design tab is a design turn, which fills the printers' tools only in part; asking for them loads
    // them whole for the next step
    const { say } = chat([{ call: LOAD_TOOLS_TOOL, args: { toolset: 'printers' } }, { call: 'connector.t20' }, { text: 'Read.' }], fleetTools(32), true)
    const one = await say('hello')
    expect(one).toHaveLength(3)
    expect(toolsOf(one[0]!)).not.toContain('connector.t20')
    expect(toolsOf(one[0]!)).toEqual(expect.arrayContaining([...SAFETY_TOOLS]))
    expect(toolsOf(one[1]!)).toContain('connector.t20')
    for (const r of one) expect(toolsOf(r).length).toBeLessThanOrEqual(128)
  })
})
