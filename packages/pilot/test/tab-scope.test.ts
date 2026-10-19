// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir in the tab, its one place in the app: with the design tools given, parts are built feature by feature (no part
// generator) beside the slicing, printer, settings and app tools, or beside the knowledge and project tools alone in
// the browser build. One prompt covers designing and slicing. Auto starts a build on muninn only for a picture or PDF,
// a request of many steps, or one that needs a size only the person knows (route.test.ts), and deep work on muninn;
// a failed build step never moves it, other failures still do.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { designSteps, designTier, HUGINN, MANY_STEPS, MUNINN } from '../src/models'
import { NEW_PROJECT_TOOL, systemPrompt } from '../src/prompt'
import { createScriptedClient, type ScriptStep } from '../src/provider/scripted'
import { createPilot, PART_GENERATORS } from '../src/runtime'
import type { CommandSpec } from '@slicerx/contracts'
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

/** The app's commands mimir gets as tools: a slice and New project (which asks the person before discarding). */
const COMMANDS: CommandSpec[] = [
  { id: 'slice', title: 'Slice the plate', section: 'slice', tool: { permission: 'slice' }, run: () => ({ status: 'done' }) },
  { id: 'project-new', title: 'New project', section: 'plate', tool: { permission: 'slice' }, run: () => ({ started: true }) },
]

function tabPilot(steps: ScriptStep[], opts: { config?: Partial<typeof AUTO>; failing?: boolean; cad?: boolean; others?: PilotTool<never>[] } = {}) {
  const client = createScriptedClient(steps, { chunk: false })
  const pilot = createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport },
    config: { ...AUTO, ...opts.config },
    policy: DEFAULT_POLICY,
    client,
    ...(opts.cad ? { scope: 'cad' as const } : {}),
    commands: opts.cad ? COMMANDS.filter((c) => c.section !== 'slice') : COMMANDS,
    tools: [geomTool('design.new'), geomTool('geom.extrude', !opts.failing), geomTool('geom.fillet', !opts.failing), geomTool('geom.info'), ...(opts.others ?? [])],
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

describe('the tab runtime', () => {
  it('has the design tools beside the slicing, printer, settings, project and app tools, and no part generator', () => {
    const { pilot } = tabPilot([{ text: 'Hi.' }])
    const names = pilot.tools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['design.new', 'geom.extrude', 'geom.fillet', 'geom.info', 'kb.search', 'kb.intent', 'parts.lookup', 'web.lookup', 'printer.list', 'printer.queue', 'settings.plan', 'project.info', 'pilot.report', 'app.slice', NEW_PROJECT_TOOL]))
    for (const n of PART_GENERATORS) expect(names).not.toContain(n)
  })

  it('in the browser build, keeps the design, knowledge, project and app tools and drops slicing and printers', () => {
    const { pilot } = tabPilot([{ text: 'Hi.' }], { cad: true })
    const names = pilot.tools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['design.new', 'geom.extrude', 'kb.search', 'parts.lookup', 'project.info', NEW_PROJECT_TOOL]))
    for (const n of ['printer.list', 'printer.queue', 'settings.plan', 'app.slice', ...PART_GENERATORS]) expect(names).not.toContain(n)
  })

  it('keeps the part generators for a host without the design tools', () => {
    const pilot = createPilot({ host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport }, config: AUTO, policy: DEFAULT_POLICY, client: createScriptedClient([]) })
    expect(pilot.tools().map((t) => t.name)).toEqual(expect.arrayContaining(['text_to_part', 'make_model']))
    const has = (n: string) => n !== 'design.new'
    expect(systemPrompt('full', has)).toMatch(/goes straight to text_to_part/)
    expect(systemPrompt('cad', has)).toMatch(/goes straight to text_to_part/)
  })

  it('one prompt covers designing and slicing; the browser build says the desktop app slices', () => {
    const prompt = systemPrompt('full')
    expect(prompt).toMatch(/design\.new/)
    expect(prompt).toMatch(/geom\.extrude or geom\.revolve/)
    expect(prompt).toMatch(/one feature at a time/)
    expect(prompt).toMatch(/pilot\.sheet/)
    expect(prompt).not.toMatch(/text_to_part|make_model/)
    expect(prompt).toMatch(/kb\.intent/)
    expect(prompt).toMatch(/need the user's approval/)
    expect(prompt).toMatch(/never start a print on your own/)
    expect(prompt).toContain(NEW_PROJECT_TOOL)
    const cad = systemPrompt('cad')
    expect(cad).toMatch(/one feature at a time/)
    expect(cad).toMatch(/desktop app does it/)
    expect(cad).not.toMatch(/approval|kb\.intent/)
    // New project is named only when it is offered
    expect(systemPrompt('full', (n) => n !== NEW_PROJECT_TOOL)).not.toContain(NEW_PROJECT_TOOL)
  })

  it('tells the model to build feature by feature with the design tools', async () => {
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

  it('stays on huginn when design calls fail', async () => {
    const { pilot, client } = tabPilot(BUILD, { failing: true })
    const ev = await run(pilot, 'A bracket with two 5 mm holes')
    expect(ev.filter((e) => e.type === 'tool_result' && !e.ok).length).toBeGreaterThanOrEqual(2)
    expect(new Set(models(client))).toEqual(new Set(['claude-haiku-5-5']))
    expect(switches(ev)).toEqual([])
  })

  it('moves up after other tools fail, as anywhere else', async () => {
    const broken = defineTool({ name: 'kb.search', version: '1.0.0', source: 'command', permission: 'read', description: 'kb for the test', input: z.object({}).passthrough(), async run() { throw new Error('offline') } }) as PilotTool<never>
    const pilot = createPilot({
      host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport },
      config: AUTO,
      policy: DEFAULT_POLICY,
      client: createScriptedClient([{ calls: [{ name: 'kb.search', args: {} }] }, { calls: [{ name: 'kb.search', args: {} }] }, { text: 'Done.' }], { chunk: false }),
      builtins: false,
      tools: [geomTool('design.new'), broken],
    })
    const ev = await run(pilot, 'What temperature for PETG?')
    expect(switches(ev)).toEqual([expect.objectContaining({ type: 'model_switch', model: 'claude-sonnet-5-5' })])
  })

  it('starts deep work on muninn: a failure to diagnose', async () => {
    const { pilot, client } = tabPilot([{ text: 'Most likely a clogged nozzle.' }])
    const ev = await run(pilot, 'Why did my print fail last night?')
    expect(models(client)).toEqual(['claude-sonnet-5-5'])
    expect(ev.find((e) => e.type === 'start')).toMatchObject({ model: 'claude-sonnet-5-5', route: { reason: 'deep' } })
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
