// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pilot.sheet shows the sizes a part is built from and waits for the person: the answer keeps each value in its row's
// bounds and says which ones changed, or that the person canceled; a bad sheet is refused before it is shown; the
// transcript keeps the sheet and its answer, and closes one left open when the run ends.
import { DEFAULT_POLICY, type ApprovalHost, type LlmTransport, type PilotEvent, type PilotSheet, type PrinterHost } from '@slicerx/contracts'
import { describe, expect, it } from 'vitest'
import { answerOf, createPilot, createScriptedClient, DEFAULT_CONFIG, sheetBindTool, sheetTool, type ScriptStep } from '../src/index'
import { foldEvents, emptyTranscript, startTurn } from '../ui/reduce'

const host = { printers: { list: async () => [], plugins: async () => [] } as unknown as PrinterHost, approvals: {} as ApprovalHost, llm: {} as LlmTransport }
const pilot = (steps: ScriptStep[]) => createPilot({ host, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, client: createScriptedClient(steps, { chunk: false }), builtins: false, tools: [sheetTool(), sheetBindTool()] })

const DIMS = [
  { key: 'phone_width', label: 'Phone width', value: 71.5, unit: 'mm', source: 'lookup', sourceTitle: 'apple.com', sourceUrl: 'https://www.apple.com/iphone/compare/' },
  { key: 'case_allowance', label: 'Case allowance', value: 1.5, unit: 'mm', min: 0, max: 5, source: 'guess' },
  { key: 'lean', label: 'Lean angle', value: 70, unit: 'deg', min: 45, max: 85, source: 'guess' },
]
const SHEET = { name: 'pilot.sheet', args: { title: 'Phone stand sizes', views: ['front', 'side'], dims: DIMS } }

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
