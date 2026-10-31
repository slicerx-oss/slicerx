// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// mimir in the tab, its one place in the app: with the design tools given, parts are built feature by feature (no part
// generator) beside the slicing, printer, settings and app tools, or beside the knowledge and project tools alone in
// the browser build. One prompt covers designing and slicing. Auto starts a build on muninn only for a picture or PDF,
// a request of many steps, or one that needs a size only the person knows (route.test.ts), and deep work on muninn;
// a failed build step never moves it, other failures still do.
import { DEFAULT_POLICY, setAssistantBrand, type ApprovalHost, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { designSteps, designTier, HUGINN, MANY_STEPS, MUNINN } from '../src/models'
import { NEW_PROJECT_TOOL, systemPrompt, tabsLine, VOICE_HEADER } from '../src/prompt'
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

  it('stays on huginn for a picture or a PDF alone, and for other files', () => {
    expect(designTier('build this', [file('a.png', 'image/png')])).toBe(HUGINN)
    expect(designTier('build this', [file('a.jpg', 'image/jpeg')])).toBe(HUGINN)
    expect(designTier('build this', [file('drawing.pdf', 'application/pdf')])).toBe(HUGINN)
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

function tabPilot(steps: ScriptStep[], opts: { config?: Partial<typeof AUTO>; failing?: boolean; cad?: boolean; others?: PilotTool<never>[]; tabs?: string[] } = {}) {
  const client = createScriptedClient(steps, { chunk: false })
  const pilot = createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport },
    config: { ...AUTO, ...opts.config },
    policy: DEFAULT_POLICY,
    client,
    ...(opts.cad ? { scope: 'cad' as const } : {}),
    ...(opts.tabs ? { tabs: opts.tabs } : {}),
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

  it("names the app's tabs to a local model, and only to a local model", async () => {
    const tabs = ['mimir (this chat)', 'Model', 'Slice', 'My models']
    const line = 'The app has these tabs: mimir (this chat), Model, Slice and My models. Name no other tab.'
    expect(tabsLine(tabs)).toBe(line)
    expect(tabsLine(['Slice'])).toBe('The app has these tabs: Slice. Name no other tab.')
    const local = tabPilot([{ text: 'Hi.' }], { config: { provider: 'openai-compatible', model: 'local-model', auto: false }, tabs })
    await run(local.pilot, 'What does this tab do?')
    const sent = String(local.client.requests[0]!.messages[0]!.content)
    expect(sent).toContain(line)
    // with the rules, before the playbooks and the edition's voice
    expect(sent.indexOf(line)).toBeGreaterThan(sent.indexOf('Untrusted data:'))
    const cloud = tabPilot([{ text: 'Hi.' }], { tabs })
    await run(cloud.pilot, 'What does this tab do?')
    const cloudSent = String(cloud.client.requests[0]!.messages[0]!.content)
    expect(cloudSent).not.toContain('The app has these tabs')
    expect(sent.replace(`\n\n${line}`, '')).toBe(cloudSent)
    // no tabs given, no line
    const none = tabPilot([{ text: 'Hi.' }], { config: { provider: 'openai-compatible', model: 'local-model', auto: false } })
    await run(none.pilot, 'What does this tab do?')
    expect(String(none.client.requests[0]!.messages[0]!.content)).not.toContain('The app has these tabs')
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

  it('a one-feature box skips the plan: plans are for parts with two or more features', () => {
    for (const scope of ['full', 'cad'] as const) {
      const prompt = systemPrompt(scope)
      const line = prompt.split('\n').find((l) => l.includes('design.plan'))!
      expect(line).toMatch(/Plans are for parts with two or more features/)
      expect(line).toMatch(/before the first geometry step, call design\.plan/)
      expect(line).toMatch(/A part of one feature \(a plain box, a spacer, a single plate\) skips the plan: once its sheet is confirmed, build it/)
      // every new part shows the sheet first (the runtime refuses a new part without one); a larger part then gets the plan
      expect(line).toMatch(/Every new part shows its sizes on the dimension sheet first/)
      expect(line).toMatch(/first the sheet, with the sizes that depend on the person's own things asked for and confirmed on it as above; then/)
      expect(line).toMatch(/as confirmed on the dimension sheet, never asked for twice/)
      // a plan answered in a later message reuses the sheet the person already confirmed
      expect(line).toMatch(/A sheet confirmed earlier in the chat still holds when the plan is answered in a later message/)
      expect(line).not.toMatch(/bound/)
      // one planning instruction, not two that overlap
      expect(prompt).not.toMatch(/one or two sentences/)
      expect(prompt.indexOf('pilot.sheet before building')).toBeLessThan(prompt.indexOf('design.plan'))
      // the plan comes before the build, and the check against the plan after it
      expect(prompt.indexOf('design.plan')).toBeLessThan(prompt.indexOf('pilot.sheet_bind'))
      expect(prompt.indexOf('design.plan')).toBeLessThan(prompt.indexOf('design.check'))
    }
    // the multi-step list stays in the whole app's prompt
    expect(systemPrompt('full')).toMatch(/Multi-step requests:/)
  })

  it('names the plan and the check only when design.plan and design.check are offered', () => {
    const without = (...gone: string[]) => (n: string) => !gone.includes(n)
    for (const scope of ['full', 'cad'] as const) {
      const noPlan = systemPrompt(scope, without('design.plan'))
      expect(noPlan).not.toMatch(/design\.plan|Plans are for parts/)
      // still sheet first, then small named steps, and a read-back after the build
      expect(noPlan).toMatch(/pilot\.sheet before building/)
      expect(noPlan).toMatch(/several small steps, each named for what it is/)
      expect(noPlan).not.toMatch(/one or two sentences/)
      // design.check without design.plan has no planned part to check: the read-back line stands in for it
      expect(noPlan).not.toMatch(/design\.check|planned part/)
      expect(noPlan).toMatch(/read the part back with geom\.info or geom\.measure and check the main sizes and holes against the request/)
      const noCheck = systemPrompt(scope, without('design.check'))
      expect(noCheck).not.toMatch(/design\.check/)
      expect(noCheck).toMatch(/design\.plan/)
      expect(noCheck).toMatch(/read the part back with geom\.info or geom\.measure and check the main sizes and holes against the request/)
      // without the design tools neither is named
      expect(systemPrompt(scope, without('design.new'))).not.toMatch(/design\.(plan|check)/)
    }
  })

  it('checks a planned part with design.check, fixes once, and on a second miss reports the failed items, never done', () => {
    setAssistantBrand({ voice: 'Short and warm.' })
    try {
      for (const scope of ['full', 'cad'] as const) {
        const prompt = systemPrompt(scope)
        const line = prompt.split('\n').find((l) => l.includes('design.check'))!
        expect(line).toMatch(/After the last feature of a planned part, call design\.check with the plan's planId/)
        expect(line).toMatch(/fix those items in one round and call design\.check again/)
        expect(line).toMatch(/If any item still fails, never say the part is done: stop building, list each failed item plainly/)
        expect(line).toMatch(/design\.check says so too, and checks that plan no more/)
        // the voice stays the last block, after the check line, and after the skill playbooks too
        expect(prompt.endsWith(`\n\n${VOICE_HEADER}\nShort and warm.`)).toBe(true)
        expect(prompt.indexOf('design.check')).toBeLessThan(prompt.indexOf(VOICE_HEADER))
        expect(systemPrompt(scope, undefined, 'Playbook: tune PETG.').endsWith(`Playbook: tune PETG.\n\n${VOICE_HEADER}\nShort and warm.`)).toBe(true)
      }
    } finally {
      setAssistantBrand()
    }
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

  it('builds on huginn for a picture or a PDF alone', async () => {
    for (const [message, files] of [
      ['Build this', [file('sketch.jpg', 'image/jpeg')]],
      ['Build the part on this drawing', [file('drawing.pdf', 'application/pdf')]],
    ] as const) {
      const { pilot, client } = tabPilot(BUILD)
      const ev = await run(pilot, message, [...files])
      expect(new Set(models(client)), message).toEqual(new Set(['claude-haiku-5-5']))
      expect(switches(ev), message).toEqual([])
    }
  })

  it('builds on muninn from the first step for many steps, and says so once', async () => {
    for (const [message, files] of [
      ['A box with a lid, a lip, rounded corners and vents', undefined],
      ['A print-in-place joint with a pin', undefined],
    ] as const) {
      const { pilot, client } = tabPilot(BUILD)
      const ev = await run(pilot, message, files ? [...files] : undefined)
      expect(models(client), message).toEqual(Array(6).fill('claude-sonnet-5-5'))
      expect(switches(ev), message).toEqual([{ type: 'model_switch', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', reason: 'request' }])
      expect(ev.find((e) => e.type === 'start')).toMatchObject({ model: 'claude-sonnet-5-5' })
    }
  })

  it('routes each message on its own: a plain follow-up goes back to huginn', async () => {
    const { pilot, client } = tabPilot([{ text: 'Read it.' }, { text: 'Made it thicker.' }])
    await run(pilot, 'A box with a lid, a lip, rounded corners and vents')
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
