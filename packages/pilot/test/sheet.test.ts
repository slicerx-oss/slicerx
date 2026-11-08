// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.sheet shows the sizes a part is built from and waits for the person: the answer keeps each value in its row's
// bounds and says which ones changed, or that the person canceled; a bad sheet is refused before it is shown; the
// transcript keeps the sheet and its answer, and closes one left open when the run ends.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PilotSheet, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { answerOf, createPilot, createScriptedClient, DEFAULT_CONFIG, sheetBindTool, sheetOf, sheetTool, type ScriptStep } from '../src/index'
import { foldEvents, emptyTranscript, startTurn } from '../ui/reduce'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const pilot = (steps: ScriptStep[]) => createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), sheetBindTool()] })

const DIMS = [
  { key: 'phone_width', label: 'Phone width', value: 71.5, unit: 'mm', source: 'lookup', sourceTitle: 'apple.com', sourceUrl: 'https://www.apple.com/iphone/compare/', at: { a: [10, -35, 6], b: [10, 35, 6], off: [0, 0, 20] } },
  { key: 'case_allowance', label: 'Case allowance', value: 1.5, unit: 'mm', min: 0, max: 5, source: 'guess', at: { a: [8, -35, 6], b: [9.5, -35, 6], off: [0, 0, 10] } },
  { key: 'lean', label: 'Lean angle', value: 70, unit: 'deg', min: 45, max: 85, source: 'guess', at: { c: [20, -35, 6], from: [1, 0, 0], to: [0.34, 0, 0.94], r: 18 } },
]
const PART = [{ plane: 'xz', points: [[0, 0], [80, 0], [80, 6], [0, 6]], from: -35, to: 35 }]
const SHEET = { name: 'pilot.sheet', args: { title: 'Phone stand sizes', views: ['front', 'side'], dims: DIMS, part: PART } }

async function play(steps: ScriptStep[], answer?: (sheet: PilotSheet) => Record<string, number> | null) {
  const p = pilot(steps)
  const events: PilotEvent[] = []
  for await (const e of p.run('s', 'A phone stand')) {
    events.push(e)
    if (e.type === 'sheet' && answer) void p.answerSheet!(e.sheet.id, answer(e.sheet))
  }
  return events
}

describe('pilot.sheet', () => {
  it('waits for the person and gives the next step the values to build with', async () => {
    const seen: string[] = []
    const events = await play(
      [
        { calls: [SHEET] },
        (messages) => {
          const last = messages.at(-1)
          seen.push(last?.role === 'tool' ? last.content : '')
          return { text: 'Building it.' }
        },
      ],
      // The person widens the case allowance, sends a lean outside its bounds, and a key the sheet does not have.
      () => ({ case_allowance: 3, lean: 95, extra: 1 }),
    )
    const shown = events.find((e) => e.type === 'sheet')
    expect(shown).toMatchObject({ sheet: { title: 'Phone stand sizes', views: ['front', 'side'], dims: DIMS } })
    const answer = { confirmed: true, values: { phone_width: 71.5, case_allowance: 3, lean: 70 }, changed: ['case_allowance'] }
    expect(events.find((e) => e.type === 'sheet_answered')).toMatchObject({ answer })
    expect(JSON.parse(seen[0]!)).toMatchObject({ ok: true, result: answer })
  })

  it('refuses a sheet with a repeated key, a lookup without its page, or a value outside its own bounds', async () => {
    for (const dims of [
      [DIMS[1], DIMS[1]],
      [{ ...DIMS[0], sourceUrl: undefined }],
      [{ ...DIMS[1], value: 9 }],
      [{ ...DIMS[0], sourceUrl: 'javascript:alert(1)' }],
    ]) {
      const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims } }] }], () => ({}))
      expect(events.some((e) => e.type === 'sheet'), JSON.stringify(dims)).toBe(false)
      expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
    }
  })

  it('refuses a sheet of several sizes with no part to draw, and keeps a one-row sheet', async () => {
    const none = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims: DIMS } }] }], () => ({}))
    expect(none.some((e) => e.type === 'sheet')).toBe(false)
    expect(none.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringContaining('needs part') })
    const one = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Bore', dims: [DIMS[1]] } }] }], () => ({}))
    expect(one.some((e) => e.type === 'sheet')).toBe(true)
  })

  // Every row has a callout: a sheet of several sizes that leaves a row off the drawing is sent back, naming the row.
  it('refuses a sheet of several sizes with a row that has no place on the drawing', async () => {
    const dims = [DIMS[0], { ...DIMS[1], at: undefined }, DIMS[2]]
    const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims, part: PART } }] }], () => ({}))
    expect(events.some((e) => e.type === 'sheet')).toBe(false)
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringContaining('row 2 (Case allowance) needs at: {"a": [x, y, z], "b": [x, y, z], "off": [x, y, z]} in mm') })
  })

  // A first sheet sent back names the exact field that is missing and the shape it needs, so the next one is right.
  describe('a sheet sent back', () => {
    const at = { a: [0, 0, 0], b: [40, 0, 0], off: [0, -8, 0] }
    const dims = [
      { key: 'length', label: 'Length', value: 40, unit: 'mm', source: 'asked', at },
      { key: 'bore', label: 'Bore', value: 16, unit: 'mm', source: 'asked', at },
    ]
    const refusal = async (args: Record<string, unknown>): Promise<string> => {
      const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', ...args } }] }], () => ({}))
      expect(events.some((e) => e.type === 'sheet')).toBe(false)
      const r = events.find((e) => e.type === 'tool_result') as { ok: boolean; summary: string }
      expect(r.ok).toBe(false)
      return r.summary
    }

    it('names a row with no place, by its number and label', async () => {
      expect(await refusal({ dims: [dims[0], { ...dims[1], at: undefined }], part: PART })).toContain('row 2 (Bore) needs at: {"a": [x, y, z], "b": [x, y, z], "off": [x, y, z]} in mm')
    })

    it('names a row whose place is missing a coordinate', async () => {
      expect(await refusal({ dims: [dims[0], { ...dims[1], at: { a: [0, 0, 0], b: [16, 0] } }], part: PART })).toContain('row 2 (Bore) needs at: {"a": [x, y, z], "b": [x, y, z], "off": [x, y, z]} in mm')
    })

    it('says what part takes when a sheet of several sizes has none', async () => {
      expect(await refusal({ dims })).toContain('needs part: [solid, ...]')
    })

    it('names a sweep profile with neither d nor points', async () => {
      const sweep = { kind: 'sweep', profile: { hole: 16 }, path: [[0, 0, 0], [0, 0, 50]] }
      expect(await refusal({ dims, part: [sweep] })).toContain('part 1 (sweep) needs profile: {"d": diameter in mm} (with "hole" for a bore) or {"points": [[x, y], ...]}')
    })

    it('names what a revolve, a loft and an extrude are missing', async () => {
      expect(await refusal({ dims, part: [{ kind: 'revolve', plane: 'xz', points: [[5, 0], [20, 0], [20, 40]] }] })).toContain('part 1 (revolve) needs axis: {"point": [x, y], "direction": [x, y]}')
      expect(await refusal({ dims, part: [PART[0], { kind: 'loft', plane: 'xy', sections: [{ at: 0, d: 60 }, { at: 100 }] }] })).toContain('part 2 (loft) section 2 needs at (mm) and either d (a diameter in mm) or points')
      expect(await refusal({ dims, part: [{ plane: 'xy', points: [[0, 0], [40, 0], [40, 20]], to: 10 }] })).toContain('part 1 (extrude) needs from: a number in mm')
    })
  })

  // The smallest sheet of each kind passes as written, and the sheet carries only the fields of its own kind.
  it('takes a minimal revolve, sweep and loft sheet, and keeps only each kind\'s own fields', () => {
    const at = { a: [0, 0, 0], b: [20, 0, 0], off: [0, 0, -8] }
    const dims = [
      { key: 'd', label: 'Diameter', value: 40, unit: 'mm', source: 'asked', at },
      { key: 'h', label: 'Height', value: 40, unit: 'mm', source: 'asked', at },
    ]
    const solids = [
      { kind: 'revolve', plane: 'xz', points: [[5, 0], [20, 0], [20, 40], [5, 40]], axis: { point: [0, 0], direction: [0, 1] } },
      { kind: 'sweep', profile: { d: 20 }, path: [[0, 0, 0], [0, 0, 50]] },
      { kind: 'loft', plane: 'xy', sections: [{ at: 0, d: 60 }, { at: 100, d: 30 }] },
    ]
    for (const solid of solids) {
      const parsed = sheetTool().input.safeParse({ title: 'Sizes', dims, part: [solid] })
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(sheetOf(parsed.data as unknown as Parameters<typeof sheetOf>[0]).part).toEqual([solid])
    }
    // a field of another kind is dropped, not carried
    const extra = sheetTool().input.safeParse({ title: 'Sizes', dims, part: [{ ...solids[0], holes: [[[0, 0], [1, 0], [1, 1]]], from: 0 }] })
    expect(sheetOf(extra.data as unknown as Parameters<typeof sheetOf>[0]).part).toEqual([solids[0]])
  })

  // A sheet for a part already built names its design and draws it as built, so it needs no solids of its own.
  it('shows a sheet for a built design with no part of its own, and carries the design', async () => {
    const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Case sizes', dims: DIMS, design: 'obj_case' } }] }], () => ({}))
    expect(events.find((e) => e.type === 'sheet')).toMatchObject({ sheet: { title: 'Case sizes', design: 'obj_case' } })
    expect((events.find((e) => e.type === 'sheet') as { sheet: PilotSheet }).sheet.part).toBeUndefined()
  })

  it('carries the part and each row\'s place on its drawing', async () => {
    const part = [{ plane: 'xz', points: [[0, 0], [80, 0], [80, 6], [0, 6]], from: -35, to: 35 }]
    const dims = [{ ...DIMS[1], at: { a: [0, -35, 0], b: [80, -35, 0], off: [0, 0, -12] } }, { ...DIMS[2], at: { c: [20, -35, 6], from: [1, 0, 0], to: [0.34, 0, 0.94], r: 18 } }]
    const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims, part } }] }], () => ({}))
    expect(events.find((e) => e.type === 'sheet')).toMatchObject({ sheet: { part, dims } })
    // a part with too few points or a place with a missing coordinate is refused
    for (const bad of [{ dims, part: [{ ...part[0], points: [[0, 0], [1, 1]] }] }, { dims: [{ ...DIMS[1], at: { a: [0, 0], b: [1, 0, 0], off: [0, 0, 0] } }] }]) {
      const out = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', ...bad } }] }], () => ({}))
      expect(out.some((e) => e.type === 'sheet'), JSON.stringify(bad)).toBe(false)
    }
  })

  it('tells the next step nothing was confirmed when the person cancels', async () => {
    const seen: string[] = []
    const events = await play(
      [
        { calls: [SHEET] },
        (messages) => {
          const last = messages.at(-1)
          seen.push(last?.role === 'tool' ? last.content : '')
          return { text: 'Nothing built.' }
        },
      ],
      () => null,
    )
    expect(events.find((e) => e.type === 'sheet_answered')).toMatchObject({ answer: { confirmed: false, changed: [] } })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
    expect(JSON.parse(seen[0]!)).toMatchObject({ ok: false, result: { confirmed: false } })
  })

  // Words written to mimir while the sheet waits set it aside: nothing is built from it, and the next step reads them.
  it('sets the sheet aside for words the person wrote while it waited, and hands the words on', async () => {
    const seen: string[] = []
    const p = pilot([
      { calls: [SHEET] },
      (messages) => {
        const last = messages.at(-1)
        seen.push(last?.role === 'tool' ? last.content : '')
        return { text: 'Making it taller.' }
      },
    ])
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'A phone stand')) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, null, '  make it 10 mm taller  ')
    }
    expect(events.find((e) => e.type === 'sheet_answered')).toMatchObject({ answer: { confirmed: false, changed: [], said: 'make it 10 mm taller' } })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringContaining('Set aside; the person wrote instead: "make it 10 mm taller"') })
    expect(JSON.parse(seen[0]!)).toMatchObject({ ok: false, result: { confirmed: false, said: 'make it 10 mm taller' } })
    // words set a sheet aside, with or without sizes typed on it
    expect(answerOf({ id: 's', title: 'T', views: ['iso'], dims: DIMS as PilotSheet['dims'] }, null, 'taller')).toMatchObject({ confirmed: false, said: 'taller' })
  })

  // Sizes typed on the sheet before the person wrote to mimir come along with the words, so none are lost.
  it('keeps the sizes typed on a sheet that words set aside, and tells mimir of them', async () => {
    const seen: string[] = []
    const p = pilot([
      { calls: [SHEET] },
      (messages) => {
        const last = messages.at(-1)
        seen.push(last?.role === 'tool' ? last.content : '')
        return { text: 'Adding the hole.' }
      },
    ])
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'A phone stand')) {
      events.push(e)
      if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, { phone_width: 75, case_allowance: 1.5, lean: 70 }, 'also add a cable hole')
    }
    expect(events.find((e) => e.type === 'sheet_answered')).toMatchObject({ answer: { confirmed: false, said: 'also add a cable hole', changed: ['phone_width'], values: { phone_width: 75 } } })
    const out = JSON.parse(seen[0]!) as { summary: string }
    expect(out.summary).toContain('Phone width 75 mm (was 71.5)')
    expect(out.summary).toContain('also add a cable hole')
  })

  // A pipe bend, a round stem and a tapered vase cannot be extruded outlines; the sheet takes them as they will be built.
  it('shows a sheet whose part is a revolve, a sweep or a loft', async () => {
    const at = { a: [-16, 0, 0], b: [16, 0, 0], off: [0, 0, -8] }
    const parts = {
      revolve: { kind: 'revolve', plane: 'xz', points: [[0, 0], [16, 0], [16, 40], [0, 40]], axis: { point: [0, 0], direction: [0, 1] } },
      sweep: { kind: 'sweep', profile: { d: 32, hole: 27 }, path: [[0, 0, 0], [0, 0, 70], [70, 0, 70]], round: 50 },
      loft: { kind: 'loft', plane: 'xy', sections: [{ at: 0, d: 32 }, { at: 40, points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] }] },
    }
    for (const [kind, solid] of Object.entries(parts)) {
      const dims = [{ ...DIMS[0], at }, { ...DIMS[1], at }]
      const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims, part: [solid] } }] }], () => ({}))
      expect(events.find((e) => e.type === 'sheet'), kind).toMatchObject({ sheet: { part: [solid] } })
    }
    // a sweep needs a path of two points at least, and a loft two sections
    for (const bad of [{ ...parts.sweep, path: [[0, 0, 0]] }, { ...parts.loft, sections: [{ at: 0, d: 32 }] }]) {
      const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims: [{ ...DIMS[0], at }, { ...DIMS[1], at }], part: [bad] } }] }], () => ({}))
      expect(events.some((e) => e.type === 'sheet'), JSON.stringify(bad)).toBe(false)
    }
  })

  // A sheet that names a design the host does not have would show no drawing, so mimir hears of it instead.
  it('refuses a sheet for a built design that is not there', async () => {
    const p = createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient([{ calls: [{ name: 'pilot.sheet', args: { title: 'Case sizes', dims: DIMS, design: 'obj_gone' } }] }, { text: 'ok' }], { chunk: false }), builtins: false, tools: [sheetTool()], sheetDesign: (id) => id === 'obj_case' })
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'Sizes')) events.push(e)
    expect(events.some((e) => e.type === 'sheet')).toBe(false)
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringContaining('no built design obj_gone') })
  })

  it('closes a sheet nobody answered when the run ends, as not confirmed', () => {
    const sheet = { id: 'sheet_1', title: 'Sizes', views: ['iso' as const], dims: DIMS as PilotSheet['dims'] }
    const t = foldEvents([{ type: 'sheet', sheet }, { type: 'done', stopReason: 'canceled', ms: 5 }], startTurn(emptyTranscript(), { user: 'hi' }, 0))
    expect(t.turns[0]!.blocks[0]).toMatchObject({ kind: 'sheet', answer: { confirmed: false, changed: [] } })
  })

  it('refuses an answer to a sheet nobody showed', async () => {
    await expect(pilot([]).answerSheet!('sheet_nope', {})).rejects.toThrow(/No open sheet/)
  })

  it('stops waiting when the run is canceled', async () => {
    const ac = new AbortController()
    const p = pilot([{ calls: [SHEET] }])
    const events: PilotEvent[] = []
    for await (const e of p.run('s', 'A phone stand', { signal: ac.signal })) {
      events.push(e)
      if (e.type === 'sheet') ac.abort()
    }
    expect(events.some((e) => e.type === 'sheet_answered')).toBe(false)
  })

  it('keeps its answer in the transcript', () => {
    const sheet = { id: 'sheet_1', title: 'Sizes', views: ['iso' as const], dims: DIMS as PilotSheet['dims'] }
    const answer = answerOf(sheet, { case_allowance: 2 })
    const t = foldEvents([{ type: 'sheet', sheet }, { type: 'sheet_answered', sheetId: 'sheet_1', answer }], startTurn(emptyTranscript(), { user: 'hi' }, 0))
    expect(t.turns[0]!.blocks[0]).toMatchObject({ kind: 'sheet', sheet: { id: 'sheet_1' }, answer: { changed: ['case_allowance'] } })
  })

  it('ties rows to steps after the build, keeping only the sheet\'s own keys', async () => {
    const bind = { name: 'pilot.sheet_bind', args: { design: 'obj_1', binds: [{ key: 'case_allowance', step: 2 }, { key: 'nope', step: 3 }] } }
    const events = await play([{ calls: [SHEET] }, { calls: [bind] }, { text: 'Done.' }], () => ({}))
    const sheetId = events.find((e) => e.type === 'sheet')?.type === 'sheet' ? (events.find((e) => e.type === 'sheet') as { sheet: { id: string } }).sheet.id : ''
    expect(events.find((e) => e.type === 'sheet_bound')).toEqual({ type: 'sheet_bound', sheetId, design: 'obj_1', binds: [{ key: 'case_allowance', step: 2 }] })
  })

  it('binds nothing in a conversation that showed no sheet', async () => {
    const events = await play([{ calls: [{ name: 'pilot.sheet_bind', args: { design: 'obj_1', binds: [{ key: 'a', step: 1 }] } }] }])
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
    expect(events.some((e) => e.type === 'sheet_bound')).toBe(false)
  })
})
