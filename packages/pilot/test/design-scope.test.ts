// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's scope: parts are built with the design tools (no part generator), the prompt says how, and Auto
// moves from huginn to muninn only for a picture or PDF, or a request of many steps; never on a tool call.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { designSteps, designTier, HUGINN, MANY_STEPS, MUNINN } from '../src/models'
import { systemPrompt } from '../src/prompt'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { createPilot, DESIGN_SCOPE_TOOLS } from '../src/runtime'
import { DEFAULT_CONFIG } from '../src/config'
import { defineTool, type PilotTool } from '../src/tool'

const file = (name: string, type: string): PilotAttachment => ({ id: name, name, type, bytes: 10, url: `data:${type};base64,AAAA` })

describe('the design tab routing rule', () => {
  it('counts each distinct feature a request names once', () => {
    expect(designSteps('a plain 40 mm cube')).toBe(0)
    expect(designSteps('a bracket with two holes')).toBe(1)
    expect(designSteps('a plate with 4 holes, holes countersunk')).toBe(2)
    expect(designSteps('a box with a lid, a lip, rounded corners and a vent slot')).toBe(5)
  })

  it('stays on huginn for a short text request', () => {
    expect(designTier('Make me a 30 mm cube')).toBe(HUGINN)
    expect(designTier('A bracket with two 5 mm holes and a fillet')).toBe(HUGINN)
    expect(designTier('A 608 bearing hub with a chamfer, a boss and holes')).toBe(HUGINN)
  })

  it(`moves to muninn at ${MANY_STEPS} distinct features`, () => {
    expect(designTier('A bracket with holes, a fillet, a chamfer and a slot')).toBe(MUNINN)
    expect(designTier('Raspberry Pi case: shell it, add standoffs, a lid with a lip and vents')).toBe(MUNINN)
  })

  it('moves to muninn for a gear, thread or pattern whatever the wording', () => {
    expect(designTier('a spur gear, module 1, 20 teeth')).toBe(MUNINN)
    expect(designTier('M8 threaded rod 40 mm')).toBe(MUNINN)
    expect(designTier('a honeycomb coaster')).toBe(MUNINN)
    expect(designTier('a plate with a pattern of 12 holes')).toBe(MUNINN)
  })

  it('moves to muninn for a picture or a PDF, never for other files', () => {
    expect(designTier('build this', [file('a.png', 'image/png')])).toBe(MUNINN)
    expect(designTier('build this', [file('a.jpg', 'image/jpeg')])).toBe(MUNINN)
    expect(designTier('build this', [file('drawing.pdf', 'application/pdf')])).toBe(MUNINN)
    expect(designTier('build this', [file('notes.txt', 'text/plain')])).toBe(HUGINN)
    expect(designTier('build this', [])).toBe(HUGINN)
  })
})

const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
const NO_APPROVALS = { register: async () => undefined, grant: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
const AUTO = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true, maxSteps: 40, maxToolCalls: 60, webSearch: false }

function geomTool(name: string, ok = true): PilotTool<never> {
  return defineTool({
    name,
    version: '1.0.0',
    source: 'command',
    permission: 'read',
    description: `${name} for the test`,
    input: z.object({}).passthrough(),
    async run() {
      if (!ok) throw new Error('the sketch does not close')
      return { summary: `${name} done` }
    },
  }) as PilotTool<never>
}

function tabPilot(steps: ScriptStep[], opts: { config?: Partial<typeof AUTO>; failing?: boolean } = {}) {
  const client = createScriptedClient(steps, { chunk: false })
  const pilot = createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport },
    config: { ...AUTO, ...opts.config },
    policy: DEFAULT_POLICY,
    client,
    scope: 'design',
    tools: [geomTool('design.new'), geomTool('geom.extrude', !opts.failing), geomTool('geom.fillet', !opts.failing), geomTool('geom.info')],
  })
  return { pilot, client }
}

async function run(pilot: ReturnType<typeof tabPilot>['pilot'], message: string, attachments?: PilotAttachment[]): Promise<PilotEvent[]> {
  const out: PilotEvent[] = []
  for await (const e of pilot.run('s', message, attachments ? { attachments } : {})) out.push(e)
  return out
}

const BUILD: ScriptStep[] = [
  { calls: [{ name: 'design.new', args: { name: 'Bracket' } }] },
  { calls: [{ name: 'geom.extrude', args: {} }] },
  { calls: [{ name: 'geom.fillet', args: {} }] },
  { calls: [{ name: 'geom.extrude', args: {} }] },
  { calls: [{ name: 'geom.info', args: {} }] },
  { text: 'Built the bracket.' },
]
const models = (client: ReturnType<typeof tabPilot>['client']) => client.requests.filter((r) => !r.webSearch).map((r) => r.model)
const switches = (ev: PilotEvent[]) => ev.filter((e) => e.type === 'model_switch')

describe('the design scope runtime', () => {
  it('has the design tools and the lookups, and no part generator or printer tool', () => {
    const { pilot } = tabPilot([{ text: 'Hi.' }])
    const names = pilot.tools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['design.new', 'geom.extrude', 'geom.fillet', 'geom.info', 'kb.search', 'web.lookup']))
    for (const n of names) expect(n.startsWith('kb.') || n === 'web.lookup' || /^(design|geom)\./.test(n), n).toBe(true)
    expect(names).not.toContain('text_to_part')
    expect(names).not.toContain('make_model')
    expect([...DESIGN_SCOPE_TOOLS].every((n) => n.startsWith('kb.') || n === 'web.lookup')).toBe(true)
  })

  it('tells the model to build feature by feature with the design tools', async () => {
    const prompt = systemPrompt('design')
    expect(prompt).toMatch(/design\.new/)
    expect(prompt).toMatch(/geom\.extrude or geom\.revolve/)
    expect(prompt).toMatch(/one feature at a time/)
    expect(prompt).toMatch(/pilot\.sheet/)
    expect(prompt).not.toMatch(/text_to_part|make_model/)
    // and the prompt the runtime sends is that one
    const { pilot, client } = tabPilot([{ text: 'Hi.' }])
    await run(pilot, 'Make me a 30 mm cube')
    const sys = client.requests[0]!.messages[0]!
    expect(sys.role).toBe('system')
    expect(String(sys.content)).toContain('one feature at a time')
    expect(String(sys.content)).not.toMatch(/text_to_part/)
  })

  it('builds a short request on huginn from start to finish, through every design tool call', async () => {
    const { pilot, client } = tabPilot(BUILD)
    const ev = await run(pilot, 'A bracket with two 5 mm holes and a fillet')
    expect(models(client)).toEqual(Array(6).fill('claude-haiku-5-5'))
    expect(switches(ev)).toEqual([])
    expect(ev.find((e) => e.type === 'start')).toMatchObject({ model: 'claude-haiku-5-5' })
  })

  it('stays on huginn when design calls fail, where the full app would move up', async () => {
    const { pilot, client } = tabPilot(BUILD, { failing: true })
    const ev = await run(pilot, 'A bracket with two 5 mm holes')
    expect(ev.filter((e) => e.type === 'tool_result' && !e.ok).length).toBeGreaterThanOrEqual(2)
    expect(new Set(models(client))).toEqual(new Set(['claude-haiku-5-5']))
    expect(switches(ev)).toEqual([])
  })

  it('ignores the design-to-muninn flag of a provider weak at building', async () => {
    const { pilot, client } = tabPilot(BUILD, { config: { deepDesign: true } })
    await run(pilot, 'A bracket with two 5 mm holes')
    expect(new Set(models(client))).toEqual(new Set(['claude-haiku-5-5']))
  })

  it('builds on muninn from the first step for a picture, a PDF or many steps, and says so once', async () => {
    for (const [message, files] of [
      ['Build this', [file('sketch.jpg', 'image/jpeg')]],
      ['Build the part on this drawing', [file('drawing.pdf', 'application/pdf')]],
      ['A box with a lid, a lip, rounded corners and vents', undefined],
    ] as const) {
      const { pilot, client } = tabPilot(BUILD)
      const ev = await run(pilot, message, files ? [...files] : undefined)
      expect(models(client), message).toEqual(Array(6).fill('claude-sonnet-5-5'))
      expect(switches(ev), message).toEqual([{ type: 'model_switch', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', reason: 'request' }])
      expect(ev.find((e) => e.type === 'start')).toMatchObject({ model: 'claude-sonnet-5-5' })
    }
  })

  it('routes each message on its own: a follow-up without a picture goes back to huginn', async () => {
    const { pilot, client } = tabPilot([{ text: 'Read it.' }, { text: 'Made it thicker.' }])
    await run(pilot, 'What is on this drawing?', [file('drawing.png', 'image/png')])
    await run(pilot, 'Make the base 4 mm thick')
    expect(models(client)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5'])
  })

  it('never switches without Auto: one pinned model, and mimir cloud', async () => {
    const { pilot, client } = tabPilot(BUILD, { config: { auto: false } })
    const ev = await run(pilot, 'Build this', [file('sketch.png', 'image/png')])
    expect(new Set(models(client))).toEqual(new Set(['claude-haiku-5-5']))
    expect(switches(ev)).toEqual([])
  })
})
