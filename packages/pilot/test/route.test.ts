// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Auto's routing by the request: a build that needs a size only the person knows (their own object, a mating size, a
// drawing to read) starts on muninn, in the full chat and in the design tab; a part with its sizes given stays on
// huginn. The run's start event carries the pick and why, on Auto only.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotAttachment, type PilotEvent, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config'
import { chatRoute, designRoute, HUGINN, MUNINN, personSizes, SIZES_GIVEN } from '../src/models'
import { createScriptedClient } from '../src/provider/scripted'
import { createPilot } from '../src/runtime'

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
const CHAT = ["How's my print going?", 'Can the AMS 2 Pro dry nylon?', 'Make my print faster', 'Slice my model with 0.2 mm layers']

describe('the person-size rule', () => {
  it('catches every request for a part sized to the person\'s own things', () => {
    for (const p of ASK) expect(personSizes(p), p).toBe(true)
  })

  it('leaves parts with their sizes given, and the app\'s own things, alone', () => {
    for (const p of [...GIVEN, ...CHAT]) expect(personSizes(p), p).toBe(false)
  })

  it(`counts a request as sized once it gives ${SIZES_GIVEN} sizes`, () => {
    expect(personSizes('Make a replacement foot cap for my chair leg, 22 mm tube')).toBe(true)
    expect(personSizes('Make a replacement foot cap for my chair leg: 22 mm tube, 15 mm deep, 2 mm wall')).toBe(false)
    expect(personSizes('A bracket for my M3 screws, 20 mm and 1/2 in')).toBe(false)
  })
})

describe('the design tab route', () => {
  it('starts every bench request on muninn, each for its reason', () => {
    for (const p of ASK) expect(designRoute(p), p).toEqual({ tier: MUNINN, reason: 'person_sizes' })
    for (const id of LADDER) expect(designRoute(FROM_DRAWING, drawing), id).toEqual({ tier: MUNINN, reason: 'attachment' })
  })

  it('keeps a sized part on huginn, and names a many-step part as that', () => {
    expect(designRoute('Make me a 30 mm cube')).toEqual({ tier: HUGINN, reason: 'default' })
    expect(designRoute('a spur gear, module 1, 20 teeth')).toEqual({ tier: MUNINN, reason: 'many_steps' })
  })
})

describe('the full chat route', () => {
  it('starts every bench request on muninn, each for its reason', () => {
    for (const p of ASK) expect(chatRoute(p), p).toEqual({ tier: MUNINN, reason: 'person_sizes' })
    for (const id of LADDER) expect(chatRoute(FROM_DRAWING, drawing), id).toEqual({ tier: MUNINN, reason: 'attachment' })
  })

  it('keeps sized parts and plain chat on huginn, and deep work stays deep', () => {
    for (const p of [...GIVEN, ...CHAT]) expect(chatRoute(p), p).toEqual({ tier: HUGINN, reason: 'default' })
    expect(chatRoute('Why did my print fail?')).toEqual({ tier: MUNINN, reason: 'deep' })
  })

  it('moves up for a picture only when the request builds from it', () => {
    expect(chatRoute('What is on this picture?', drawing)).toEqual({ tier: HUGINN, reason: 'default' })
    expect(chatRoute(FROM_DRAWING, [file('notes.txt', 'text/plain')])).toEqual({ tier: HUGINN, reason: 'default' })
  })
})

const NO_PRINTERS = { list: async () => [], plugins: async () => [] } as unknown as PrinterHost
const NO_APPROVALS = { register: async () => undefined, grant: async () => undefined, deny: async () => undefined } as unknown as ApprovalHost
const AUTO = { ...DEFAULT_CONFIG, provider: 'anthropic', model: 'claude-haiku-5-5', models: { huginn: 'claude-haiku-5-5', muninn: 'claude-sonnet-5-5' }, billing: 'key' as const, auto: true, webSearch: false }

async function first(message: string, opts: { auto?: boolean; scope?: 'design' } = {}): Promise<{ start: PilotEvent | undefined; models: string[] }> {
  const client = createScriptedClient([{ text: 'How thick is it?' }], { chunk: false })
  const pilot = createPilot({
    host: { printers: NO_PRINTERS, approvals: NO_APPROVALS, llm: {} as LlmTransport },
    config: { ...AUTO, auto: opts.auto ?? true },
    policy: DEFAULT_POLICY,
    client,
    builtins: false,
    tools: [],
    ...(opts.scope ? { scope: opts.scope } : {}),
  })
  const ev: PilotEvent[] = []
  for await (const e of pilot.run('s', message)) ev.push(e)
  return { start: ev.find((e) => e.type === 'start'), models: client.requests.filter((r) => !r.webSearch).map((r) => r.model) }
}

describe('the run on Auto', () => {
  it('asks its first question on muninn for a person-size build and says why at the start', async () => {
    for (const scope of [undefined, 'design'] as const) {
      const { start, models } = await first(ASK[0]!, scope ? { scope } : {})
      expect(models, scope).toEqual(['claude-sonnet-5-5'])
      expect(start, scope).toMatchObject({ model: 'claude-sonnet-5-5', route: { tier: MUNINN, reason: 'person_sizes' } })
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
