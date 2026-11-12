// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.sheet shows the sizes a part is built from and waits for the person: the answer keeps each value in its row's
// bounds and says which ones changed, or that the person canceled; a bad sheet is refused before it is shown; the
// transcript keeps the sheet and its answer, and closes one left open when the run ends.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PilotSheet, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { answerOf, createPilot, createScriptedClient, DEFAULT_CONFIG, sheetBindTool, sheetOf, sheetProblems, sheetTool, type ScriptStep } from '../src/index'
import { localToolDef, toolSpec } from '../src/tool'
import { foldEvents, emptyTranscript, startTurn } from '../ui/reduce'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const pilot = (steps: ScriptStep[]) => createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), sheetBindTool()] })

const DIMS = [
  { key: 'phone_width', label: 'Phone width', value: 71.5, unit: 'mm', source: 'lookup', sourceTitle: 'apple.com', sourceUrl: 'https://www.apple.com/iphone/compare/', at: { a: [10, -35, 6], b: [10, 35, 6], off: [0, 0, 20] } },
  { key: 'case_allowance', label: 'Case allowance', value: 1.5, unit: 'mm', min: 0, max: 5, source: 'guess', at: { a: [8, -35, 6], b: [9.5, -35, 6], off: [0, 0, 10] } },
  { key: 'lean', label: 'Lean angle', value: 70, unit: 'deg', min: 45, max: 85, source: 'guess', at: { c: [20, -35, 6], from: [1, 0, 0], to: [0.34, 0, 0.94], r: 18 } },
]
const PART = [{ plane: 'xz', points: [[0, 0], [80, 0], [80, 6], [0, 6]], from: -35, to: 35 }]
const SHEET = { name: 'pilot.sheet', args: { title: 'Phone stand sizes', fits: true, views: ['front', 'side'], dims: DIMS, part: PART } }

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

  it('refuses a sheet with a repeated key, a lookup that names no page, or a value outside its own bounds', async () => {
    for (const dims of [
      [DIMS[1], DIMS[1]],
      [{ ...DIMS[0], sourceUrl: undefined, sourceTitle: undefined }],
      [{ ...DIMS[1], value: 9 }],
      [{ ...DIMS[0], sourceUrl: 'javascript:alert(1)' }],
    ]) {
      const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims } }] }], () => ({}))
      expect(events.some((e) => e.type === 'sheet'), JSON.stringify(dims)).toBe(false)
      expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
    }
  })

  it('shows a looked-up value with the page title alone, when the lookup gave no link', async () => {
    const events = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Sizes', dims: [{ ...DIMS[0], sourceUrl: undefined }] } }] }], () => ({}))
    const sheet = events.find((e) => e.type === 'sheet')
    expect(sheet).toBeDefined()
    expect((sheet as { sheet: { dims: { sourceTitle?: string; sourceUrl?: string }[] } }).sheet.dims[0]).toMatchObject({ sourceTitle: 'apple.com' })
  })

  it('shows a count row with no place among sizes that have one, since a count is no length on the part', async () => {
    const at = { a: [0, 0, 0], b: [40, 0, 0] }
    const dims = [
      { key: 'length', label: 'Length', value: 40, unit: 'mm', source: 'asked', at },
      { key: 'spokes', label: 'Spokes', value: 6, unit: 'mm', source: 'guess' },
      { key: 'rows', label: 'Rows', value: 2, unit: 'mm', kind: 'count', source: 'guess' },
    ]
    const shown = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Wheel', dims, part: PART } }] }], () => ({}))
    expect(shown.some((e) => e.type === 'sheet')).toBe(true)
    const width = await play([{ calls: [{ name: 'pilot.sheet', args: { title: 'Wheel', dims: [...dims, { key: 'width', label: 'Width', value: 8, unit: 'mm', source: 'guess' }], part: PART } }] }], () => ({}))
    expect(width.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, summary: expect.stringContaining('row 4 (Width) needs at') })
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

  // Every bound the sheet had when each kind was its own schema still holds: one bad field per row, each refused with
  // the part or row named, so a model can fix its sheet and nothing malformed reaches the drawing.
  describe('keeps every bound on the part and the rows', () => {
    const at = { a: [0, 0, 0], b: [40, 0, 0], off: [0, -8, 0] }
    const dims = [
      { key: 'length', label: 'Length', value: 40, unit: 'mm', source: 'asked', at },
      { key: 'bore', label: 'Bore', value: 16, unit: 'mm', source: 'asked', at },
    ]
    const sq = [[0, 0], [40, 0], [40, 20], [0, 20]]
    const extrude = { plane: 'xy', points: sq, from: 0, to: 10 }
    const revolve = { kind: 'revolve', plane: 'xz', points: [[5, 0], [20, 0], [20, 40], [5, 40]], axis: { point: [0, 0], direction: [0, 1] } }
    const sweep = { kind: 'sweep', profile: { d: 20, hole: 16 }, path: [[0, 0, 0], [0, 0, 50], [50, 0, 50]], round: 25 }
    const loft = { kind: 'loft', plane: 'xy', sections: [{ at: 0, d: 60 }, { at: 100, d: 30 }] }
    const ring = (n: number) => Array.from({ length: n }, (_, k) => [Math.cos((k / n) * 2 * Math.PI) * 10, Math.sin((k / n) * 2 * Math.PI) * 10])
    const line = (n: number) => Array.from({ length: n }, (_, k) => [k, 0, 0])
    const parts = (solid: Record<string, unknown>) => ({ part: [solid] })
    const row = (n: number, patch: Record<string, unknown>) => ({ dims: dims.map((d, k) => (k === n ? { ...d, ...patch } : d)), part: [extrude] })
    const cases: [string, Record<string, unknown>, string][] = [
      ['a coordinate of 10001 mm', parts({ ...extrude, points: [[0, 0], [10_001, 0], [40, 20]] }), 'part 1 (extrude) needs points'],
      ['an extrude from 10001 mm', parts({ ...extrude, from: 10_001 }), 'part 1 (extrude) needs from'],
      ['an extrude to -10001 mm', parts({ ...extrude, to: -10_001 }), 'part 1 (extrude) needs to'],
      ['an outline of 2 points', parts({ ...extrude, points: [[0, 0], [40, 0]] }), 'part 1 (extrude) needs points'],
      ['an outline of 201 points', parts({ ...extrude, points: ring(201) }), 'part 1 (extrude) needs points'],
      ['an outline point of 3 coordinates', parts({ ...extrude, points: [[0, 0, 0], [40, 0], [40, 20]] }), 'part 1 (extrude) needs points'],
      ['an extrude with no plane', parts({ ...extrude, plane: undefined }), 'part 1 (extrude) needs plane'],
      ['21 holes', parts({ ...extrude, holes: Array.from({ length: 21 }, () => [[1, 1], [2, 1], [2, 2]]) }), 'part 1 (extrude) needs holes'],
      ['a hole of 2 points', parts({ ...extrude, holes: [[[1, 1], [2, 1]]] }), 'part 1 (extrude) needs holes'],
      ['a revolve with no axis', parts({ ...revolve, axis: undefined }), 'part 1 (revolve) needs axis'],
      ['a revolve axis point of 10001 mm', parts({ ...revolve, axis: { point: [10_001, 0], direction: [0, 1] } }), 'part 1 (revolve) needs axis'],
      ['a revolve axis direction of 3 coordinates', parts({ ...revolve, axis: { point: [0, 0], direction: [0, 1, 0] } }), 'part 1 (revolve) needs axis'],
      ['a zero revolve axis', parts({ ...revolve, axis: { point: [0, 0], direction: [0, 0] } }), 'part 1 (revolve) needs axis'],
      ['a revolve angle of 361', parts({ ...revolve, angle: 361 }), 'part 1 (revolve) needs angle'],
      ['a revolve angle of -361', parts({ ...revolve, angle: -361 }), 'part 1 (revolve) needs angle'],
      ['a revolve outline of 2 points', parts({ ...revolve, points: [[5, 0], [20, 0]] }), 'part 1 (revolve) needs points'],
      ['a revolve with no plane', parts({ ...revolve, plane: undefined }), 'part 1 (revolve) needs plane'],
      ['a sweep with no profile', parts({ ...sweep, profile: undefined }), 'part 1 (sweep) needs profile'],
      ['a sweep profile with both d and points', parts({ ...sweep, profile: { d: 20, points: sq } }), 'part 1 (sweep) needs profile'],
      ['a sweep profile d of 0.05', parts({ ...sweep, profile: { d: 0.05 } }), 'part 1 (sweep) needs profile'],
      ['a sweep profile d of 10001', parts({ ...sweep, profile: { d: 10_001 } }), 'part 1 (sweep) needs profile'],
      ['a sweep hole of 0.05', parts({ ...sweep, profile: { d: 20, hole: 0.05 } }), 'part 1 (sweep) needs profile'],
      ['a sweep hole as wide as d', parts({ ...sweep, profile: { d: 20, hole: 20 } }), 'part 1 (sweep) needs profile'],
      ['a sweep outline profile with a hole of -1', parts({ ...sweep, profile: { points: sq, hole: -1 } }), 'part 1 (sweep) needs profile'],
      ['a sweep outline profile of 2 points', parts({ ...sweep, profile: { points: [[0, 0], [1, 0]] } }), 'part 1 (sweep) needs profile'],
      ['a sweep path of 1 point', parts({ ...sweep, path: [[0, 0, 0]] }), 'part 1 (sweep) needs path'],
      ['a sweep path of 101 points', parts({ ...sweep, path: line(101) }), 'part 1 (sweep) needs path'],
      ['a sweep path point of 2 coordinates', parts({ ...sweep, path: [[0, 0], [0, 0, 50]] }), 'part 1 (sweep) needs path'],
      ['a sweep path point of 10001 mm', parts({ ...sweep, path: [[0, 0, 0], [0, 0, 10_001]] }), 'part 1 (sweep) needs path'],
      ['a sweep round of -1', parts({ ...sweep, round: -1 }), 'part 1 (sweep) needs round'],
      ['a sweep round of 10001', parts({ ...sweep, round: 10_001 }), 'part 1 (sweep) needs round'],
      ['a loft of 1 section', parts({ ...loft, sections: [{ at: 0, d: 60 }] }), 'part 1 (loft) needs sections'],
      ['a loft of 21 sections', parts({ ...loft, sections: Array.from({ length: 21 }, (_, k) => ({ at: k, d: 10 })) }), 'part 1 (loft) needs sections'],
      ['a loft section with both d and points', parts({ ...loft, sections: [{ at: 0, d: 60, points: sq }, { at: 100, d: 30 }] }), 'part 1 (loft) section 1 needs'],
      ['a loft section d of 0.05', parts({ ...loft, sections: [{ at: 0, d: 60 }, { at: 100, d: 0.05 }] }), 'part 1 (loft) section 2 needs'],
      ['a loft section at 10001 mm', parts({ ...loft, sections: [{ at: 0, d: 60 }, { at: 10_001, d: 30 }] }), 'part 1 (loft) section 2 needs'],
      ['a loft section outline of 2 points', parts({ ...loft, sections: [{ at: 0, d: 60 }, { at: 100, points: [[0, 0], [1, 0]] }] }), 'part 1 (loft) section 2 needs'],
      ['a loft with no plane', parts({ ...loft, plane: undefined }), 'part 1 (loft) needs plane'],
      ['41 solids', { part: Array.from({ length: 41 }, () => extrude) }, 'part takes 1 to 40 solids'],
      ['no solids', { part: [] }, 'part takes 1 to 40 solids'],
      ['a row value of 100001', row(0, { value: 100_001 }), 'row 1 (Length) value is outside'],
      ['a row min of -100001', row(0, { min: -100_001 }), 'row 1 (Length) min is outside'],
      ['a row max of 100001', row(0, { max: 100_001 }), 'row 1 (Length) max is outside'],
      ['a row at coordinate of 10001 mm', row(1, { at: { ...at, b: [10_001, 0, 0] } }), 'row 2 (Bore) needs at'],
      ['a row at point of 4 coordinates', row(1, { at: { ...at, off: [0, -8, 0, 1] } }), 'row 2 (Bore) needs at'],
      ['an angle at with r 0.05', row(1, { at: { c: [0, 0, 0], from: [1, 0, 0], to: [0, 1, 0], r: 0.05 } }), 'row 2 (Bore) needs at'],
      ['an angle at with r 10001', row(1, { at: { c: [0, 0, 0], from: [1, 0, 0], to: [0, 1, 0], r: 10_001 } }), 'row 2 (Bore) needs at'],
      ['an angle at with only c, from and r', row(1, { at: { c: [0, 0, 0], from: [1, 0, 0], r: 10 } }), 'row 2 (Bore) needs at'],
      ['an angle at with only to', row(1, { at: { to: [0, 1, 0] } }), 'row 2 (Bore) needs at'],
    ]
    it.each(cases)('refuses %s', (_, patch, named) => {
      const parsed = sheetTool().input.safeParse({ title: 'Sizes', dims, ...patch })
      expect(parsed.success).toBe(false)
      expect(parsed.error!.issues.map((i) => i.message).join('; ')).toContain(named)
    })

    it('takes a length with no off, and draws it with none, so the drawing moves its callout off the part', () => {
      const parsed = sheetTool().input.safeParse({ title: 'Sizes', dims: [dims[0], { ...dims[1], at: { a: at.a, b: at.b } }], part: [extrude] })
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(sheetOf(parsed.data as unknown as Parameters<typeof sheetOf>[0]).dims[1]!.at).toEqual({ a: at.a, b: at.b, off: [0, 0, 0] })
    })

    it('takes each kind at its bounds', () => {
      for (const solid of [
        { ...extrude, points: ring(200), holes: Array.from({ length: 20 }, () => [[1, 1], [2, 1], [2, 2]]), from: -10_000, to: 10_000 },
        { ...revolve, angle: -360 },
        { ...sweep, profile: { d: 10_000, hole: 0.1 }, path: line(100), round: 0 },
        { ...loft, sections: Array.from({ length: 20 }, (_, k) => ({ at: k, d: 0.1 })) },
      ]) {
        const parsed = sheetTool().input.safeParse({ title: 'Sizes', dims: [{ ...dims[0], value: 100_000, min: -100_000, max: 100_000 }, { ...dims[1], at: { c: [0, 0, 0], from: [1, 0, 0], to: [0, 1, 0], r: 0.1 } }], part: Array.from({ length: 40 }, () => solid) })
        expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 2))).toBe(true)
      }
    })

    // a kind the sheet does not draw is refused by the schema itself, at that part's kind
    it('refuses a kind it does not draw', () => {
      const parsed = sheetTool().input.safeParse({ title: 'Sizes', dims, part: [extrude, { ...extrude, kind: 'cylinder' }] })
      expect(parsed.success).toBe(false)
      expect(parsed.error!.issues[0]!.path).toEqual(['part', 1, 'kind'])
    })
  })

  // The part is one object whose fields are all optional, so the schema's required list says nothing per kind: what a
  // model reads in the description is all it has. Each kind keeps its required fields and a working example there, in
  // the schema a cloud model and MCP clients get and in the one a local model gets.
  it.each([
    ['cloud', () => toolSpec(sheetTool()).inputSchema],
    ['local', () => localToolDef(sheetTool()).parameters],
  ] as const)('tells a %s model which fields each kind of solid needs', (_, schemaOf) => {
    type Node = { properties: Record<string, Node>; items: Node; enum?: string[]; description?: string }
    const schema = schemaOf() as unknown as Node
    const item = schema.properties['part']!.items
    expect(item.properties['kind']!.enum).toEqual(['extrude', 'revolve', 'sweep', 'loft'])
    const byKind = item.description!.split('By kind: ')[1]!.split(/(?=\b(?:revolve|sweep|loft): )/)
    const needs: Record<string, string[]> = { extrude: ['plane', 'points', 'from', 'to'], revolve: ['plane', 'points', 'axis \\{point, direction\\}'], sweep: ['profile', 'path'], loft: ['plane', 'sections'] }
    expect(byKind.map((s) => s.match(/^\w+/)![0])).toEqual(Object.keys(needs))
    for (const text of byKind) {
      const kind = text.match(/^\w+/)![0]
      const [fields, example] = text.split('e.g. ')
      for (const f of needs[kind]!) expect(fields, kind).toMatch(new RegExp(`\\b${f}(?!\\w)`))
      // its example is a solid the sheet takes as written
      const solid = JSON.parse(example!.trim().replace(/\.$/, '')) as Record<string, unknown>
      expect(solid['kind'] ?? 'extrude').toBe(kind)
      expect(sheetProblems({ title: 'Sizes', views: ['iso'], dims: [], part: [solid] as never }), kind).toEqual([])
    }
    const place = schema.properties['dims']!.items.properties['at']!.description!
    for (const f of ['a', 'b', 'off', 'c', 'from', 'to', 'r']) expect(place).toMatch(new RegExp(`\\b${f}\\b`))
    // the compact form stays compact
    expect(JSON.stringify(schema).length).toBeLessThan(4_400)
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

  // A count given in mm reads with no unit and an angle in degrees, as the sheet shows them.
  it('names a typed count with no unit and an angle in degrees when words set the sheet aside', async () => {
    const gear = [
      { key: 'teeth', label: 'Teeth', value: 18, unit: 'mm', source: 'guess', at: { a: [0, 0, 0], b: [10, 0, 0], off: [0, 0, 5] } },
      { key: 'draft_angle', label: 'Draft', value: 1, unit: 'mm', source: 'guess', at: { a: [0, 0, 0], b: [0, 10, 0], off: [0, 0, 5] } },
      { key: 'width', label: 'Width', value: 40, unit: 'mm', source: 'guess', at: { a: [0, 0, 0], b: [0, 0, 6], off: [5, 0, 0] } },
    ]
    const seen: string[] = []
    const p = pilot([
      { calls: [{ name: 'pilot.sheet', args: { title: 'Gear sizes', fits: true, views: ['front'], dims: gear, part: PART } }] },
      (messages) => {
        const last = messages.at(-1)
        seen.push(last?.role === 'tool' ? last.content : '')
        return { text: 'OK.' }
      },
    ])
    for await (const e of p.run('s', 'A gear')) if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, { teeth: 20, draft_angle: 2, width: 42 }, 'make it thinner')
    const out = JSON.parse(seen[0]!) as { summary: string }
    expect(out.summary).toContain('They had typed on it: Teeth 20 (was 18), Draft 2° (was 1), Width 42 mm (was 40); keep those.')
  })

  it('takes a kind on a row, count, angle or length, and names typed sizes by it', async () => {
    const dims = (kind: unknown) => [{ key: 'width', label: 'Width', value: 4, unit: 'mm', kind, source: 'guess' }]
    expect(sheetTool().input.safeParse({ title: 'Sizes', views: ['front'], dims: dims('count') }).success).toBe(true)
    expect(sheetTool().input.safeParse({ title: 'Sizes', views: ['front'], dims: [{ key: 'width', label: 'Width', value: 4, unit: 'mm', source: 'guess' }] }).success).toBe(true)
    for (const bad of ['deg', 'number', 2]) expect(sheetTool().input.safeParse({ title: 'Sizes', views: ['front'], dims: dims(bad) }).success, String(bad)).toBe(false)
    expect(sheetTool().version).toBe('1.4.0')
    const seen: string[] = []
    const p = pilot([
      { calls: [{ name: 'pilot.sheet', args: { title: 'Odd sizes', fits: true, views: ['front'], dims: [{ ...dims('count')[0], at: { a: [0, 0, 0], b: [10, 0, 0], off: [0, 0, 5] } }, { key: 'teeth', label: 'Teeth', value: 20, unit: 'mm', kind: 'length', source: 'guess', at: { a: [0, 0, 0], b: [0, 10, 0], off: [0, 0, 5] } }], part: PART } }] },
      (messages) => {
        const last = messages.at(-1)
        seen.push(last?.role === 'tool' ? last.content : '')
        return { text: 'OK.' }
      },
    ])
    for await (const e of p.run('s', 'odd')) if (e.type === 'sheet') void p.answerSheet!(e.sheet.id, { width: 5, teeth: 21 }, 'later')
    expect((JSON.parse(seen[0]!) as { summary: string }).summary).toContain('They had typed on it: Width 5 (was 4), Teeth 21 mm (was 20); keep those.')
  })

  it('refuses a row whose kind and unit disagree, naming the row and what to give', () => {
    const one = (unit: string, kind: string) => sheetTool().input.safeParse({ title: 'Sizes', views: ['front'], dims: [{ key: 'lean', label: 'Lean', value: 15, unit, kind, source: 'guess' }] })
    const said = (unit: string, kind: string) => {
      const r = one(unit, kind)
      return r.success ? 'ok' : r.error.issues.map((i) => i.message).join('; ')
    }
    expect(said('deg', 'length')).toBe('row 1 (Lean) is kind length but unit deg; give unit mm or %, or kind angle')
    expect(said('%', 'count')).toBe('row 1 (Lean) is kind count but unit %; give unit mm, or kind length')
    expect(said('%', 'angle')).toBe('row 1 (Lean) is kind angle but unit %; give unit mm or deg, or kind length')
    expect(said('deg', 'count')).toBe('row 1 (Lean) is kind count but unit deg; give unit mm, or kind angle')
    for (const [unit, kind] of [['mm', 'count'], ['mm', 'angle'], ['deg', 'angle'], ['mm', 'length'], ['%', 'length']]) expect(said(unit!, kind!), `${unit} ${kind}`).toBe('ok')
    expect(sheetTool().localDescription).toMatch(/\bkind\b/)
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

  it('refuses an empty bind with what to do instead: bind once built, or skip the call', async () => {
    const events = await play([{ calls: [SHEET] }, { calls: [{ name: 'pilot.sheet_bind', args: { design: 'obj_1', binds: [] } }] }, { text: 'Done.' }], () => ({}))
    const r = events.filter((e) => e.type === 'tool_result').at(-1) as { ok?: boolean; summary?: string } | undefined
    expect(r?.ok).toBe(false)
    expect(r?.summary).toMatch(/tie rows once the part is built, and skip this call when no row sets one step/)
    expect(events.some((e) => e.type === 'sheet_bound')).toBe(false)
  })

  it('binds nothing in a conversation that showed no sheet', async () => {
    const events = await play([{ calls: [{ name: 'pilot.sheet_bind', args: { design: 'obj_1', binds: [{ key: 'a', step: 1 }] } }] }])
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false })
    expect(events.some((e) => e.type === 'sheet_bound')).toBe(false)
  })
})
