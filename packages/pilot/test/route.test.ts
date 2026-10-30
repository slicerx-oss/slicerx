// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto's routing by the request: a build that needs a size only the person knows (their own object, a mating size, a
// mating part) starts on muninn, in the full chat and in the design tab; a part with its sizes given stays on
// huginn. The run's start event carries the pick and why, on Auto only.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import { chatRoute, designRoute, HUGINN, MUNINN, personSizes, SIZES_GIVEN, tabRoute } from '../src/models'
import { createScriptedClient } from '../src/provider/scripted'
import { createPilot } from '../src/runtime'
import { defineTool, type PilotTool } from '../src/tool'
import { z } from 'zod'

/** Parts described as working with another part, in general words. */
const MECHANISM = [
  'A print-in-place joint with a pin, about 40 mm wide.',
  'Two toothed wheels that mesh, 20 mm and 40 mm across.',
  'A rail with a matching carriage that slides along it, 80 mm long.',
  'A latch arm that pivots on a 4 mm pin.',
  'A two part case that snaps together, 60 x 40 x 20 mm.',
]
/** Plain parts that share words with the above but do not work with another part. */
const PLAIN = ['A 40 mm slide for a toy marble run', 'A rail 80 mm long with two 4 mm holes', 'Make me a 30 mm cube']

const file = (name: string, type: string): PilotAttachment => ({ id: name, name, type, bytes: 10, url: `data:${type};base64,AAAA` })
const drawing = [file('drawing.png', 'image/png')]

/** Requests for a part sized to the person's own things: each needs a size only they can measure. */
const ASK = [
  'Make a hook that hangs over my shelf so I can hang my headphones under it.',
  'Make a clip that slides onto the edge of my desk and holds 3 USB cables.',
  'Make a replacement foot cap for my chair leg. The leg is a round metal tube.',
  'Make a wall bracket for my curtain rod.',
  'Make a pegboard hook that holds my screwdriver.',
  'Make a press-fit replacement lid for a glass jar.',
  'Make a divider wall for my kitchen drawer.',
  'Make a spacer that goes between my cabinet door and its knob so the knob sits further out.',
]

/** Drawings that leave some sizes out, sent as a picture with the request. */
const LADDER = ['plate-4holes', 'block-bore', 'open-box', 'flange', 'nema17-plate', 'stepped-shaft', 'hinge', 'bearing-housing', 'spur-gear']
const FROM_DRAWING = 'Model this part from the drawing I attached.'

/** Parts with every size given, and chat that builds nothing. */
const GIVEN = [
  'Make a 40 x 30 x 5 mm plate with four 3.4 mm holes, 4 mm from each corner.',
  'Make me a 30 mm cube',
  'Design a cylinder 20 mm across and 50 mm tall with a 6 mm hole through the middle.',
  'Model a 60 mm long, 15 mm wide, 3 mm thick strip with a 5 mm hole at each end.',
  'Make a hook for my shelf: the board is 18 mm thick, 40 mm drop, 25 mm wide.',
  'A 608 bearing hub with a chamfer, a boss and holes',
]
/** Parts that mate with a standard part, or name a size, or only stand on or show the person's things: nothing to measure. */
const KNOWN = [
  'Make a slim case for an iPhone 15 (147.6 x 71.6 x 7.8 mm), 1.5 mm walls, with a cutout for the camera bump.',
  'Make a slim case for my Pixel 9, 1.5 mm walls, with a cutout for the camera bar.',
  'Make me a wall hook for a 6 mm screw.',
  'Make a pillow block for a 608 bearing, press fit, with two M4 mounting holes 40 mm apart.',
  'Make an open tray for a Raspberry Pi 4 to sit in, with four standoffs under its mounting holes.',
  'Make a desk dock that holds my iPhone 15 upright by its bottom edge, no case on the phone.',
  'Make a little stand that holds one credit card upright on my desk.',
  'Design a case for a Raspberry Pi 4 with screw posts and cable cutouts.',
  'A statue of my dog, a labrador lying down.',
]
/** The same kinds of request where the person still has to say which thing, or measure it. */
const WHICH = ['Make a case for my iPhone.', 'Make a bracket for a NEMA motor.', 'Make a mount for my GoPro that screws to my desk.']
const CHAT = ["How's my print going?", 'Can the AMS 2 Pro dry nylon?', 'Make my print faster', 'Slice my model with 0.2 mm layers']

describe('the person-size rule', () => {
  it('catches every request for a part sized to the person\'s own things', () => {
    for (const p of ASK) expect(personSizes(p), p).toBe(true)
  })

  it('leaves parts with their sizes given, and the app\'s own things, alone', () => {
    for (const p of [...GIVEN, ...CHAT]) expect(personSizes(p), p).toBe(false)
  })

  it('leaves a standard part, a named size, a place it stands and a figure alone', () => {
    for (const p of KNOWN) expect(personSizes(p), p).toBe(false)
    for (const p of WHICH) expect(personSizes(p), p).toBe(true)
  })

  it(`counts a request as sized once it gives ${SIZES_GIVEN} sizes`, () => {
    expect(personSizes('Make a replacement foot cap for my chair leg, 22 mm tube')).toBe(true)
    expect(personSizes('Make a replacement foot cap for my chair leg: 22 mm tube, 15 mm deep, 2 mm wall')).toBe(false)
    expect(personSizes('A bracket for my M3 screws, 20 mm and 1/2 in')).toBe(false)
    expect(personSizes('A sleeve for my torch, 30 x 30 mm')).toBe(true)
    expect(personSizes('A sleeve for my torch, 30 x 30 x 120 mm')).toBe(false)
  })
})

describe('the design tab route', () => {
  it('starts every bench request on muninn, each for its reason', () => {
    for (const p of ASK) expect(designRoute(p), p).toEqual({ tier: MUNINN, reason: 'person_sizes' })
  })

  it('keeps a drawing alone on huginn: a picture or PDF no longer moves a design run', () => {
    for (const id of LADDER) expect(designRoute(FROM_DRAWING, drawing), id).toEqual({ tier: HUGINN, reason: 'default' })
    expect(designRoute(FROM_DRAWING, [file('drawing.pdf', 'application/pdf')])).toEqual({ tier: HUGINN, reason: 'default' })
  })

  it('moves a part that works with another part to muninn, by how it is described', () => {
    for (const p of MECHANISM) expect(designRoute(p), p).toEqual({ tier: MUNINN, reason: 'mechanism' })
    // a drawing does not take that away, and a plain part with the same nouns stays put
    expect(designRoute(MECHANISM[0]!, drawing)).toEqual({ tier: MUNINN, reason: 'mechanism' })
    for (const p of PLAIN) expect(designRoute(p), p).toEqual({ tier: HUGINN, reason: 'default' })
  })

  it('keeps a sized part on huginn, and names a many-step part as that', () => {
    expect(designRoute('Make me a 30 mm cube')).toEqual({ tier: HUGINN, reason: 'default' })
    expect(designRoute('a spur gear, module 1, 20 teeth')).toEqual({ tier: MUNINN, reason: 'many_steps' })
  })
})

describe('the tab route, for designing and slicing in one chat', () => {
  it('routes a build as the design route does', () => {
    for (const p of ASK) expect(tabRoute(p), p).toEqual({ tier: MUNINN, reason: 'person_sizes' })
    for (const id of LADDER) expect(tabRoute(FROM_DRAWING, drawing), id).toEqual({ tier: HUGINN, reason: 'default' })
    for (const p of MECHANISM) expect(tabRoute(p), p).toEqual({ tier: MUNINN, reason: 'mechanism' })
    expect(tabRoute('a spur gear, module 1, 20 teeth')).toEqual({ tier: MUNINN, reason: 'many_steps' })
  })

  it('keeps sized parts and plain chat on huginn, and starts deep work deep', () => {
    for (const p of [...GIVEN, ...KNOWN, ...CHAT]) expect(tabRoute(p), p).toEqual({ tier: HUGINN, reason: 'default' })
    expect(tabRoute('Why did my print fail?')).toEqual({ tier: MUNINN, reason: 'deep' })
    expect(tabRoute('Plan 12 strong PETG brackets by Friday')).toEqual({ tier: MUNINN, reason: 'deep' })
  })
})

describe('the chat route without the design tools', () => {
  it('starts every bench request on muninn, each for its reason', () => {
    for (const p of ASK) expect(chatRoute(p), p).toEqual({ tier: MUNINN, reason: 'person_sizes' })
    for (const id of LADDER) expect(chatRoute(FROM_DRAWING, drawing), id).toEqual({ tier: HUGINN, reason: 'default' })
    for (const p of MECHANISM.map((m) => `Make this. ${m}`)) expect(chatRoute(p), p).toEqual({ tier: MUNINN, reason: 'mechanism' })
  })

  it('keeps sized parts and plain chat on huginn, and deep work stays deep', () => {
    for (const p of [...GIVEN, ...KNOWN, ...CHAT]) expect(chatRoute(p), p).toEqual({ tier: HUGINN, reason: 'default' })
    expect(chatRoute('Why did my print fail?')).toEqual({ tier: MUNINN, reason: 'deep' })
  })

  it('does not move up for a picture, whether or not the request builds from it', () => {
    expect(chatRoute('What is on this picture?', drawing)).toEqual({ tier: HUGINN, reason: 'default' })
    expect(chatRoute(FROM_DRAWING, [file('notes.txt', 'text/plain')])).toEqual({ tier: HUGINN, reason: 'default' })
  })
})

const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
const NO_APPROVALS = { register: async () => undefined, grant: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
const AUTO = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true, webSearch: false }

/** A tool named design.new, which makes the runtime build with the design tools (the mimir tab). */
const DESIGN_NEW = defineTool({ name: 'design.new', version: '1.0.0', source: 'command', permission: 'read', description: 'design.new for the test', input: z.object({}), async run() { return { summary: 'ok' } } }) as PilotTool<never>

async function first(message: string, opts: { auto?: boolean; designs?: boolean } = {}): Promise<{ start: PilotEvent | undefined; models: string[] }> {
  const client = createScriptedClient([{ text: 'How thick is it?' }], { chunk: false })
  const pilot = createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport },
    config: { ...AUTO, auto: opts.auto ?? true },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: opts.designs ? [DESIGN_NEW] : [],
  })
  const ev: PilotEvent[] = []
  for await (const e of pilot.run('s', message)) ev.push(e)
  return { start: ev.find((e) => e.type === 'start'), models: client.requests.filter((r) => !r.webSearch).map((r) => r.model) }
}

/** A design.check that reports the part against its plan: `pass` false is a miss, though the call itself worked. */
const checkTool = (pass: boolean) => defineTool({ name: 'design.check', version: '1.0.0', source: 'command', permission: 'read', description: 'design.check for the test', input: z.object({}), async run() { return { summary: pass ? 'all checks pass' : '2 of 9 checks fail', output: { pass } } } }) as PilotTool<never>
const failingBuild = defineTool({ name: 'design.extrude', version: '1.0.0', source: 'command', permission: 'read', description: 'design.extrude for the test', input: z.object({}), async run() { return { ok: false, summary: 'no profile' } } }) as PilotTool<never>

async function runWith(message: string, script: Parameters<typeof createScriptedClient>[0], tools: PilotTool<never>[]): Promise<{ models: string[]; switches: string[] }> {
  const client = createScriptedClient(script, { chunk: false })
  const pilot = createPilot({ host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport }, config: AUTO, policy: DEFAULT_POLICY, client, builtins: false, tools: [DESIGN_NEW, ...tools] })
  const ev: PilotEvent[] = []
  for await (const e of pilot.run('s', message)) ev.push(e)
  return { models: client.requests.filter((r) => !r.webSearch).map((r) => r.model), switches: ev.filter((e) => e.type === 'model_switch').map((e) => (e as { reason: string }).reason) }
}

describe('a design run that misses its plan', () => {
  it('steps up to muninn after a failed design check, and says so once', async () => {
    const r = await runWith('Make me a 30 mm cube', [{ calls: [{ name: 'design.check', args: {} }] }, { text: 'It is off.' }], [checkTool(false)])
    expect(r.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(r.switches).toEqual(['struggle'])
  })

  it('stays on huginn when the check passes, and when a build call fails', async () => {
    const ok = await runWith('Make me a 30 mm cube', [{ calls: [{ name: 'design.check', args: {} }] }, { text: 'Matches.' }], [checkTool(true)])
    expect(ok.models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
    const build = await runWith('Make me a 30 mm cube', [{ calls: [{ name: 'design.extrude', args: {} }] }, { calls: [{ name: 'design.extrude', args: {} }] }, { text: 'Done.' }], [failingBuild])
    expect(build.models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5'])
    expect(build.switches).toEqual([])
  })
})

/** A part generator that builds (or fails to build) a whole part in one call, for a chat without the design tools. */
const partTool = (name: 'text_to_part' | 'make_model', ok = true) => defineTool({ name, version: '1.0.0', source: 'command', permission: 'read', description: `${name} for the test`, input: z.object({}), async run() { return ok ? { summary: 'built the part', output: { objectId: 'p1' } } : { ok: false, summary: 'could not build it' } } }) as PilotTool<never>

/** A run in a chat without the design tools, where a part comes from text_to_part or make_model. */
async function runChat(message: string, script: Parameters<typeof createScriptedClient>[0], tools: PilotTool<never>[], config: Partial<typeof AUTO> & { deepDesign?: boolean } = {}): Promise<{ models: string[]; switches: string[] }> {
  const client = createScriptedClient(script, { chunk: false })
  const pilot = createPilot({ host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport }, config: { ...AUTO, ...config }, policy: DEFAULT_POLICY, client, builtins: false, tools })
  const ev: PilotEvent[] = []
  for await (const e of pilot.run('s', message)) ev.push(e)
  return { models: client.requests.filter((r) => !r.webSearch).map((r) => r.model), switches: ev.filter((e) => e.type === 'model_switch').map((e) => (e as { reason: string }).reason) }
}

describe('a design run that builds with a part generator', () => {
  it('stays on huginn after text_to_part or make_model', async () => {
    for (const name of ['text_to_part', 'make_model'] as const) {
      const r = await runChat('Make me a 30 mm cube', [{ calls: [{ name, args: {} }] }, { text: 'Built it.' }], [partTool(name)])
      expect(r.models, name).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5'])
      expect(r.switches, name).toEqual([])
    }
  })

  it('still steps up after a failed design check that follows one', async () => {
    for (const name of ['text_to_part', 'make_model'] as const) {
      const r = await runChat('Make me a 30 mm cube', [{ calls: [{ name, args: {} }] }, { calls: [{ name: 'design.check', args: {} }] }, { text: 'It is off.' }], [partTool(name), checkTool(false)])
      expect(r.models, name).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
      expect(r.switches, name).toEqual(['struggle'])
    }
  })

  it('still steps up when the part generator really fails', async () => {
    const r = await runChat('Make me a 30 mm cube', [{ calls: [{ name: 'text_to_part', args: {} }] }, { calls: [{ name: 'text_to_part', args: {} }] }, { text: 'Could not.' }], [partTool('text_to_part', false)])
    expect(r.models).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(r.switches).toEqual(['struggle'])
  })

  it('moves to muninn on a part generator when Auto runs on a key weak at building parts', async () => {
    const r = await runChat('Make me a 30 mm cube', [{ calls: [{ name: 'text_to_part', args: {} }] }, { text: 'Built it.' }], [partTool('text_to_part')], { deepDesign: true })
    expect(r.models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(r.switches).toEqual(['tool'])
  })
})

describe('the run on Auto', () => {
  it('asks its first question on muninn for a person-size build and says why at the start', async () => {
    for (const designs of [false, true]) {
      const { start, models } = await first(ASK[0]!, { designs })
      expect(models, String(designs)).toEqual(['claude-sonnet-5-5'])
      expect(start, String(designs)).toMatchObject({ model: 'claude-sonnet-5-5', route: { tier: MUNINN, reason: 'person_sizes' } })
    }
  })

  it('says huginn and why for a sized part', async () => {
    const { start, models } = await first(GIVEN[0]!)
    expect(models).toEqual(['claude-haiku-5-5'])
    expect(start).toMatchObject({ model: 'claude-haiku-5-5', route: { tier: HUGINN, reason: 'default' } })
  })

  it('carries no route when one model is pinned', async () => {
    const { start, models } = await first(ASK[0]!, { auto: false })
    expect(models).toEqual(['claude-haiku-5-5'])
    expect(start).not.toHaveProperty('route')
  })
})
