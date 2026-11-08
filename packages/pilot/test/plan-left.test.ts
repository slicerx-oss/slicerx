// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A reply that would end with the approved plan unfinished goes on once. The two creative recordings that stopped
// early (gear-pair: a plate and two pins, then "the gears are not done yet"; planetary-gear: every gear built with no
// step tagged for its feature, then "Should I add the 0.3 mm clearance and a carrier arm ...?") replay here, call by
// call and with their last words, on a small design host. mimir is told once what the plan still needs, the chat shows
// a short notice that is not the person's message, and a second stop ends the run as usual. A run with no approved
// plan, a canceled run, the slow_down give-up line, an error, design.check's stop and a question the plan does not
// settle all end as before.
import { DEFAULT_POLICY, type LlmTransport, type PilotEvent } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { score } from '../evals/score'
import type { Audit } from '../evals/harness'
import type { Scenario } from '../evals/types'
import { createPilot, createScriptedClient, DEFAULT_CONFIG, defineTool, type PilotTool } from '../src/index'
import { PLAN_LEFT_CODE, PLAN_LEFT_PREFIX, unsettledQuestion } from '../src/plan-left'
import type { LlmClient, LlmEvent, LlmMessage, LlmRequest } from '../src/provider/types'
import type { ScriptStepData } from '../src/provider/scripted'
import { SLOW_DOWN_LINE } from '../src/slow-down-lines'
import { emptyTranscript, foldEvents, restoredTranscript, startTurn, transcriptTurns } from '../ui/reduce'

type Args = Record<string, unknown>
interface Step {
  id: string
  name: string
  feature?: string
  made?: string
}
interface Design {
  id: string
  name: string
  steps: Step[]
  parts: string[]
}

/**
 * The design tools as small fakes that answer the way the real ones do (designSummary: the design, its step count,
 * lastStep with its id and plan feature, and the parts), enough to replay a recording's calls. `check` is what
 * design.check answers.
 */
function designTools(check: () => Record<string, unknown> = () => ({ pass: false })): PilotTool<never>[] {
  const designs = new Map<string, Design>()
  let ids = 0
  const get = (id: unknown): Design => {
    const d = typeof id === 'string' ? designs.get(id) : undefined
    if (!d) throw new Error(`design: no design ${String(id)}; design.list lists them`)
    return d
  }
  const summary = (d: Design) => {
    const last = d.steps.at(-1)
    return {
      design: d.id,
      name: d.name,
      steps: d.steps.length,
      ...(last ? { lastStep: { index: d.steps.length, id: last.id, name: last.name, ...(last.feature ? { feature: last.feature } : {}) } } : {}),
      parts: d.parts.map((name, index) => ({ index, name })),
    }
  }
  const step = (d: Design, name: string, a: Args, made?: string): Step => {
    const s: Step = { id: `smuo69q8${String(++ids).padStart(2, '0')}`, name, ...(typeof a['feature'] === 'string' ? { feature: a['feature'] } : {}), ...(made ? { made } : {}) }
    d.steps.push(s)
    return s
  }
  const tool = (name: string, run: (a: Args) => { summary: string; output?: unknown }): PilotTool<never> =>
    defineTool<Args>({ name, version: '1', description: name, source: 'command', permission: 'read', input: z.record(z.string(), z.unknown()), run: async (a) => run(a) }) as PilotTool<never>
  return [
    tool('design.plan', () => ({ summary: 'Approved as shown', output: { planId: 'plan_1', accepted: true } })),
    tool('design.new', (a) => {
      const d: Design = { id: `d${designs.size + 1}`, name: String(a['name']), steps: [], parts: [] }
      designs.set(d.id, d)
      return { summary: `Started ${d.name} (${d.id})`, output: summary(d) }
    }),
    tool('geom.extrude', (a) => {
      const d = get(a['design'])
      if (a['target'] !== undefined && a['part'] === undefined) throw new Error('target: with a design, join and cut work on its "part"')
      const op = a['operation'] ?? 'new'
      const made = op === 'new' ? String(a['name'] ?? 'Body') : undefined
      if (made) d.parts.push(made)
      const s = step(d, 'Sketch extrude 10 mm', a, made)
      return { summary: `Extruded: step ${d.steps.length}, ${s.name}`, output: summary(d) }
    }),
    tool('geom.array', (a) => {
      const d = get(a['design'])
      const count = Number((a['spec'] as { count?: unknown } | undefined)?.count ?? 2)
      if (a['merge'] === false) for (let k = 1; k < count; k++) d.parts.push(d.parts[Number(a['part'] ?? 0)] ?? 'Copy')
      step(d, `Array of ${count}`, a)
      return { summary: `Arrayed ${count} copies`, output: summary(d) }
    }),
    tool('geom.boolean', (a) => {
      const d = get(a['design'])
      const drop = new Set((a['with_parts'] as number[] | undefined) ?? [])
      d.parts = d.parts.filter((_, i) => !drop.has(i))
      step(d, 'Join 1 part', a)
      return { summary: 'Union', output: summary(d) }
    }),
    tool('geom.info', (a) => ({ summary: '1 part, closed', output: { design: get(a['design']).id } })),
    tool('design.undo', (a) => {
      const d = get(a['design'])
      const last = d.steps.pop()
      if (last?.made) d.parts.splice(d.parts.lastIndexOf(last.made), 1)
      return { summary: `Removed ${last?.name ?? 'nothing'}`, output: summary(d) }
    }),
    tool('design.edit_step', (a) => {
      const d = get(a['design'])
      const s = d.steps.find((x) => x.id === a['step'])
      if (s && typeof a['feature'] === 'string') s.feature = a['feature']
      return { summary: 'Edited', output: { ...summary(d), steps: d.steps.map((x, i) => ({ index: i + 1, id: x.id, name: x.name, ...(x.feature ? { feature: x.feature } : {}) })) } }
    }),
    tool('design.check', (a) => {
      const out: Record<string, unknown> = { planId: a['planId'], design: 'd1', designName: 'Part', chosen: 'tied to the plan', nozzleMm: 0.4, items: [], ...check() }
      return { summary: out['pass'] === true ? 'all checks pass' : 'checks failed', output: out }
    }),
  ]
}

const call = (name: string, args: Args) => ({ name, args })

// gear-pair, recorded 2026-11-07: the plan, then the plate and two pins (the first pin refused, since it gave the
// plate's name in place of its part number), then the last words with no tool call
const GEAR_PAIR_FEATURES = ['Base plate', 'Pin 20T', 'Pin 40T', 'Gear 20T', 'Gear 40T']
const GEAR_PAIR_LAST =
  "The base plate and both pins are built, but the gears are not done yet, so nothing is ready to print or queue.\n\n- **Done:** a 120 × 75 × 4 mm base plate with a 5 mm pin at each gear center (30, 37.5) and (75, 37.5), each 10 mm tall. The plan and sizes were confirmed.\n- **Still to do:** the 20-tooth gear (pitch 30 mm, outside 33 mm, face 8 mm, 5.4 mm bore) and the 40-tooth gear (pitch 60 mm, outside 63 mm, face 8 mm, 5.4 mm bore). The tooth flanks will be closed polylines approximating the involute, so the teeth will mesh only approximately.\n- **Open question:** should the gears print loose on their pins, as the plan assumed, or be fixed to them? The 0.4 mm bore clearance only makes sense if they are loose.\n\nOnce you confirm the loose-gear assumption, I'll build the two gears, check the design against the plan, then pick the printer and spool and slice. I won't queue anything until you ask."
const GEAR_PAIR: ScriptStepData[] = [
  { text: 'The sizes are confirmed. Next I will set out the build plan for the design.', calls: [call('design.plan', { part: 'Meshing spur gear pair on base plate', units: 'mm', features: GEAR_PAIR_FEATURES.map((name) => ({ name, kind: 'extrude', sizes: {} })), assumptions: ['Gears are separate pieces that turn on their own pins, bore 0.4 mm over the 5 mm pin.'], questions: ['Are the pins meant to stay fixed to the plate and the gears print loose on them, or should the gears be fixed on their pins?'] })] },
  { text: 'The plan is approved, so I will start with the base plate.', calls: [call('design.new', { name: 'Meshing spur gear pair on base plate' })] },
  { calls: [call('geom.extrude', { design: 'd1', operation: 'new', name: 'Base plate' })] },
  { text: 'The base plate is built. Next I will add the two pins.', calls: [call('geom.extrude', { design: 'd1', operation: 'join', target: 'Base plate', name: 'Pin 20T' })] },
  { calls: [call('geom.extrude', { design: 'd1', operation: 'join', part: 0, name: 'Pin 20T' })] },
  { text: 'The 20T pin is joined to the plate. Next is the 40T pin.', calls: [call('geom.extrude', { design: 'd1', operation: 'join', part: 0, name: 'Pin 40T' })] },
  { text: GEAR_PAIR_LAST },
]

// planetary-gear, recorded 2026-11-07: the plan, the ring, sun and three planets built with no step tagged for its
// feature, design.check failing on that (its first check, so no stop), then a question the plan already settles
const PLANETARY_FEATURES = ['Ring gear', 'Sun gear', 'Planet gears (x3)']
const PLANETARY_LAST =
  'I built the planetary set as four separate bodies, but it is not ready to print yet.\n\n- **Built:** a ring gear (70 mm outer diameter, 10 mm thick, 30 internal teeth), a sun (10 teeth) and three planets (10 teeth each, 120 degrees apart).\n- **Check:** the plan check fails on feature count, 13 build steps against the 3 planned features.\n- **Missing for print-in-place:** there is no carrier arm, so the planets have nothing holding them in place. Nothing has been arranged, sliced or sent to the printer.\n\nShould I add the 0.3 mm clearance and a carrier arm with planet pins before I arrange and slice?'
const PLANETARY: ScriptStepData[] = [
  { text: 'The sheet is confirmed. Next I will set out the build plan for the three gears.', calls: [call('design.plan', { part: 'Planetary gear set (ring, sun, 3 planets)', units: 'mm', features: PLANETARY_FEATURES.map((name) => ({ name, kind: 'extrude', sizes: {} })), assumptions: ['Radial clearance of 0.3 mm between planet tips and ring roots', 'No carrier arm: the planets are free-floating, as the request lists only sun, planets and ring'], questions: ['Do you want a carrier arm and planet pins so the planets stay in place in the print?'] })] },
  { text: 'The plan is approved. I will build the ring first.', calls: [call('design.new', { name: 'Planetary gear set' }), call('geom.extrude', { design: 'Planetary gear set', operation: 'new', name: 'Ring gear' })] },
  { calls: [call('geom.extrude', { design: 'd1', operation: 'new', name: 'Ring gear' })] },
  { text: 'The ring body is in. Next one internal tooth.', calls: [call('geom.extrude', { design: 'd1', operation: 'new', name: 'Ring tooth' })] },
  { text: 'The tooth landed at the bed origin. I will remove that step.', calls: [call('design.undo', { design: 'd1' }), call('geom.info', { design: 'd1' })] },
  { text: 'I will place the tooth from the ring center.', calls: [call('geom.extrude', { design: 'd1', operation: 'new', name: 'Ring tooth' })] },
  { text: 'Next I will copy it 30 times around the ring center.', calls: [call('geom.array', { design: 'd1', part: 1, spec: { kind: 'circular', count: 30 }, merge: true })] },
  { text: 'Now I will join them to the ring.', calls: [call('geom.boolean', { design: 'd1', op: 'union', part: 0, with_parts: [1] })] },
  { text: 'The ring is one body. Now the sun.', calls: [call('geom.extrude', { design: 'd1', operation: 'new', name: 'Sun gear' }), call('geom.extrude', { design: 'd1', operation: 'new', name: 'Sun tooth' })] },
  { text: 'I will copy the tooth 10 times and join it to the sun.', calls: [call('geom.array', { design: 'd1', part: 2, spec: { kind: 'circular', count: 10 }, merge: true })] },
  { calls: [call('geom.boolean', { design: 'd1', op: 'union', part: 1, with_parts: [2] })] },
  { text: 'The sun is complete. Next one planet.', calls: [call('geom.extrude', { design: 'd1', operation: 'new', name: 'Planet gear' }), call('geom.extrude', { design: 'd1', operation: 'new', name: 'Planet tooth' })] },
  { text: 'The planet tooth landed at x 127. I will undo that step and redo it.', calls: [call('design.undo', { design: 'd1' }), call('geom.extrude', { design: 'd1', operation: 'new', name: 'Planet tooth' })] },
  { text: 'I will copy it around the planet center and join it.', calls: [call('geom.array', { design: 'd1', part: 3, spec: { kind: 'circular', count: 10 }, merge: true })] },
  { calls: [call('geom.boolean', { design: 'd1', op: 'union', part: 2, with_parts: [3] }), call('geom.array', { design: 'd1', part: 2, spec: { kind: 'linear', count: 3 }, merge: false })] },
  { text: 'All four gears are built. I will check the design against the plan.', calls: [call('design.check', { planId: 'plan_1', design: 'd1' })] },
  { text: PLANETARY_LAST },
]

const HOST = { printers: { list: async () => [], plugins: async () => [] }, approvals: { register: async () => undefined, deny: async () => undefined }, llm: {} as LlmTransport } as never

async function replay(client: LlmClient, opts: { tools?: PilotTool<never>[]; signal?: AbortSignal; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {}) {
  const pilot = createPilot({ host: HOST, config: { ...DEFAULT_CONFIG, maxSteps: 40, maxToolCalls: 80 }, policy: DEFAULT_POLICY, client, builtins: false, tools: opts.tools ?? designTools(), ...(opts.sleep ? { sleep: opts.sleep } : {}) })
  const events: PilotEvent[] = []
  for await (const e of pilot.run('s', 'Make the part', opts.signal ? { signal: opts.signal } : {})) events.push(e)
  return { pilot, events }
}

/** The runtime's notes that the plan is not finished, in what a request carried. */
const notes = (messages: readonly LlmMessage[]): string[] => messages.flatMap((m) => (m.role === 'user' && m.content.startsWith(PLAN_LEFT_PREFIX) ? [m.content] : []))
const notices = (events: readonly PilotEvent[]) => events.filter((e) => e.type === 'error' && e.code === PLAN_LEFT_CODE)
const done = (events: readonly PilotEvent[]) => events.find((e) => e.type === 'done')

describe("the gear-pair recording's last reply", () => {
  it('goes on once, to the two gears no step built, and names the built plate and pins to tag rather than build', async () => {
    const client = createScriptedClient([...GEAR_PAIR, { text: 'The gears are built.' }], { chunk: false })
    const { events } = await replay(client)
    const last = client.requests.at(-1)!
    const sent = notes(last.messages)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Still to build: Gear 20T, Gear 40T.')
    expect(sent[0]).toMatch(/"Base plate" \(step "smuo69q801"\), "Pin 20T" \(step "smuo69q802"\), "Pin 40T" \(step "smuo69q803"\)/)
    expect(sent[0]).toContain('design.edit_step')
    expect(sent[0]).toContain('design.check (planId plan_1)')
    // the note is the turn after the reply's own last words, which stay in the conversation
    expect(last.messages.at(-2)).toMatchObject({ role: 'assistant', content: GEAR_PAIR_LAST })
    expect(last.toolChoice).toBe('auto')
    expect(notices(events)).toEqual([{ type: 'error', code: PLAN_LEFT_CODE, waiting: true, retryable: false, message: 'mimir went on to the parts the plan still needs: Gear 20T and Gear 40T.' }])
    // the model stopped again: the run ends as usual
    expect(done(events)).toMatchObject({ stopReason: 'end' })
  })
})

describe("the planetary-gear recording's last reply", () => {
  it('goes on once, naming the three planned features no step is tagged for, each with the step that built it', async () => {
    const client = createScriptedClient([...PLANETARY, { text: 'Tagged and checked.' }], { chunk: false })
    const { events } = await replay(client)
    const sent = notes(client.requests.at(-1)!.messages)
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('Still to build')
    // the ring's first extrude was refused, so its step is the next one; the undone teeth leave no step behind
    expect(sent[0]).toMatch(/"Ring gear" \(step "smuo69q801"\), "Sun gear" \(step "smuo69q806"\), "Planet gears \(x3\)" \(step "smuo69q810"\)\. Do not build these again/)
    expect(notices(events)).toEqual([expect.objectContaining({ message: 'mimir went on to finish the plan, marking the steps that built Ring gear, Sun gear and Planet gears (x3).' })])
    expect(done(events)).toMatchObject({ stopReason: 'end' })
  })
})

describe('at most one nudge in a run', () => {
  it('a reply that stops twice with the plan still unfinished gets exactly one, and the second stop ends the run', async () => {
    const client = createScriptedClient([...GEAR_PAIR, { text: 'Should I go on with the gears?' }, { text: 'Still waiting on you.' }], { chunk: false })
    const { events } = await replay(client)
    expect(notes(client.requests.at(-1)!.messages)).toHaveLength(1)
    expect(notices(events)).toHaveLength(1)
    expect(client.remaining()).toBe(1)
    expect(done(events)).toMatchObject({ stopReason: 'end' })
  })

  it('the nudge is no message of the person: the chat keeps one turn, and a restored chat reads the same', async () => {
    const client = createScriptedClient([...GEAR_PAIR, { text: 'The gears are built.' }], { chunk: false })
    const { events } = await replay(client)
    const t = foldEvents(events, startTurn(emptyTranscript(), { user: 'Make the part' }, 0))
    expect(t.turns).toHaveLength(1)
    const turns = transcriptTurns(t)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.user).toBe('Make the part')
    expect(turns[0]!.reply).not.toContain('went on')
    expect(turns[0]!.reply.endsWith('The gears are built.')).toBe(true)
    expect(transcriptTurns(restoredTranscript(t))).toEqual(turns)
    // the notice is a block of the reply, never a bubble
    expect(t.turns[0]!.blocks.filter((b) => b.kind === 'error' && b.code === PLAN_LEFT_CODE)).toHaveLength(1)
  })
})

describe('a reply that ends as before', () => {
  /** A step that hands back a scripted reply as events. */
  const events = (text: string): LlmEvent[] => [{ type: 'text', delta: text }, { type: 'done', stop: 'end' }]
  function client(steps: ScriptStepData[], last: (req: LlmRequest) => LlmEvent[]): LlmClient & { requests: LlmRequest[] } {
    const inner = createScriptedClient(steps, { chunk: false })
    const requests: LlmRequest[] = []
    let i = 0
    return {
      provider: 'scripted',
      requests,
      async *stream(req, signal) {
        requests.push(req)
        if (i++ < steps.length) yield* inner.stream(req, signal)
        else yield* last(req)
      },
    }
  }
  const head = GEAR_PAIR.slice(0, -1)

  it('with no approved plan', async () => {
    const steps = [...GEAR_PAIR.slice(1, -1), { text: 'The plate and pins are built; the gears are next.' }, { text: 'never sent' }]
    const c = createScriptedClient(steps, { chunk: false })
    const { events } = await replay(c)
    expect(notes(c.requests.at(-1)!.messages)).toEqual([])
    expect(notices(events)).toEqual([])
    expect(c.remaining()).toBe(1)
  })

  it('when the person cancels the run as the reply ends', async () => {
    const ac = new AbortController()
    const c = client(head, () => {
      ac.abort()
      return events('The gears are next.')
    })
    const { events: got } = await replay(c, { signal: ac.signal })
    expect(c.requests.flatMap((r) => notes(r.messages))).toEqual([])
    expect(notices(got)).toEqual([])
  })

  it('on the line that free mimir stopped at its limit', async () => {
    const c = client(head, () => [{ type: 'error', message: 'slow down', retryable: true, code: 'slow_down' }, { type: 'done', stop: 'end' }])
    const { events: got } = await replay(c, { sleep: async () => undefined })
    expect(got.some((e) => e.type === 'error' && e.message === SLOW_DOWN_LINE)).toBe(true)
    expect(c.requests.flatMap((r) => notes(r.messages))).toEqual([])
    expect(notices(got)).toEqual([])
  })

  it('on an error', async () => {
    const c = client(head, () => [{ type: 'error', message: 'The provider failed.', retryable: true }, { type: 'done', stop: 'end' }])
    const { events: got } = await replay(c)
    expect(done(got)).toMatchObject({ stopReason: 'error' })
    expect(notices(got)).toEqual([])
  })

  it("when design.check's stop is in force after the plan's fix round", async () => {
    const steps = [...PLANETARY.slice(0, -1), { text: 'The feature count is still off: the plan wants three features. Should I keep going?' }, { text: 'never sent' }]
    const c = createScriptedClient(steps, { chunk: false })
    const { events } = await replay(c, { tools: designTools(() => ({ pass: false, stop: 'The fix round is used: stop building, and tell the person exactly what is off.' })) })
    expect(notes(c.requests.at(-1)!.messages)).toEqual([])
    expect(notices(events)).toEqual([])
  })

  it('when design.check passed after the last step', async () => {
    const steps = [...PLANETARY.slice(0, -1), { text: 'All checks pass.' }, { text: 'never sent' }]
    const c = createScriptedClient(steps, { chunk: false })
    const { events } = await replay(c, { tools: designTools(() => ({ pass: true })) })
    expect(notices(events)).toEqual([])
    expect(c.remaining()).toBe(1)
  })

  it('when the last words ask for a decision the plan does not settle', async () => {
    const steps = [...head, { text: 'The plate and pins are built. What bore diameter should the gears have?' }, { text: 'never sent' }]
    const c = createScriptedClient(steps, { chunk: false })
    const { events } = await replay(c)
    expect(notices(events)).toEqual([])
    expect(c.remaining()).toBe(1)
  })

  it('once every planned feature has a tagged step', async () => {
    const tagged: ScriptStepData[] = [
      GEAR_PAIR[0]!,
      GEAR_PAIR[1]!,
      ...GEAR_PAIR_FEATURES.map((name, i) => ({ calls: [call('geom.extrude', { design: 'd1', operation: i ? 'join' : 'new', part: 0, name, feature: name.toLowerCase() })] })),
      { text: 'The plate, pins and both gears are built.' },
      { text: 'never sent' },
    ]
    const c = createScriptedClient(tagged, { chunk: false })
    const { events } = await replay(c)
    expect(notices(events)).toEqual([])
    expect(c.remaining()).toBe(1)
  })
})

describe('which questions the plan settles', () => {
  it.each([
    'Should I add the 0.3 mm clearance and a carrier arm with planet pins before I arrange and slice?',
    '- **Open question:** should the gears print loose on their pins, as the plan assumed, or be fixed to them?',
    'Want me to build the lid next?',
    'Shall I continue with the gears, or stop here?',
    'Ready for me to go on?',
    'The plate is built. Next are the gears.',
  ])('goes on after "%s"', (text) => {
    expect(unsettledQuestion(text)).toBeUndefined()
  })

  it.each([
    'What bore diameter should the gears have?',
    'Should the lid snap on or slide in?',
    'Should I use 3 mm or 4 mm pins?',
    'Do you want it in PETG?',
    'How tall should the pins be, given the gear face?',
  ])('waits for the person after "%s"', (text) => {
    expect(unsettledQuestion(text)).toBeDefined()
  })
})

describe('the eval score', () => {
  const audit = (): Audit => ({ verifies: [], sideEffects: [], granted: new Map(), unapproved: () => [] })
  const scenario = { id: 'plan', title: 'plan', expect: {} } as unknown as Scenario
  it('takes nothing off for the notice that mimir went on with its plan', () => {
    const s = score(scenario, { events: [{ type: 'error', message: 'mimir went on to the parts the plan still needs: Gear 20T.', retryable: false, code: PLAN_LEFT_CODE, waiting: true }], overrides: {}, audit: audit() })
    expect(s.efficiency).toBe(10)
    expect(s.notes.join(' ')).not.toMatch(/error/)
  })
})

describe("a local model's context", () => {
  it("keeps the person's request and the plan with the run when the note follows them, rather than dropping them as an earlier turn", async () => {
    const { fitContext } = await import('../src/context')
    const big = 'x'.repeat(12000)
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are mimir.' },
      { role: 'user', content: 'Make a gear pair' },
      { role: 'assistant', content: 'The plan.', toolCalls: [{ id: 'c1', name: 'design.plan', arguments: '{}' }] },
      { role: 'tool', callId: 'c1', content: big },
      { role: 'assistant', content: 'Should I go on?' },
      { role: 'user', content: `${PLAN_LEFT_PREFIX} (plan plan_1, Gear pair), so keep building now.` },
    ]
    const fit = fitContext(messages, [], 4000)
    expect(fit.droppedTurns).toBe(0)
    expect(fit.messages.some((m) => m.role === 'user' && m.content === 'Make a gear pair')).toBe(true)
  })
})
