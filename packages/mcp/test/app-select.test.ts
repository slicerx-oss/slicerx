// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The Select Other tools forward to the open app, list what is under a spot and pick one by index with the selection
// read back, check the spot before anything leaves, and pass the app's refusals on with their meaning.
import { describe, expect, it, vi } from 'vitest'
import type { AppLinkCaller } from '../src/app-route'
import { appSelectTools, type SelectCandidate, type SelectPicked, type SelectUnder } from '../src/app-select'
import { ToolInputError } from '../src/errors'

const refuse = (code: string) => (async () => {
  throw Object.assign(new Error(`refused: ${code}`), { code })
}) as AppLinkCaller['call']

const CANDIDATES: SelectCandidate[] = [
  { index: 0, kind: 'edge', label: 'Straight edge', object: 'Bracket', objectId: 'a', part: 0, triangle: 4, pointMm: [1, 2, 3], depthMm: 10 },
  { index: 1, kind: 'face', label: 'Top face', object: 'Bracket', objectId: 'a', part: 0, triangle: 4, pointMm: [1, 2, 3], depthMm: 10 },
  { index: 2, kind: 'body', label: 'Body', object: 'Bracket', objectId: 'a', pointMm: [1, 2, 3], depthMm: 10 },
]

/** A stand-in app: what is under the spot, and the selection a pick leaves. */
function app() {
  let selection: SelectPicked['selection'] = { readout: 'Nothing selected', selectedIds: [], picks: [] }
  const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
    const under: SelectUnder = { at: { x: 80, y: 60 }, view: { width: 800, height: 600 }, candidates: CANDIDATES }
    if (method === 'select.under') return under
    const c = CANDIDATES[args!['index'] as number]!
    selection = c.kind === 'body' ? { readout: 'Bracket', selectedIds: ['a'], picks: [] } : { readout: `1 ${c.kind} on Bracket`, selectedIds: ['a'], picks: [{ kind: c.kind, objectId: 'a', part: 0, triangle: 4 }] }
    return { ...under, picked: c, selection }
  })
  return { call, selection: () => selection }
}

describe('app select tools', () => {
  it('list everything under a spot and pick one by index, the selection read back from the app', async () => {
    const a = app()
    const [under, other] = appSelectTools({ call: a.call } as AppLinkCaller, 'SlicerX')
    expect(under!.name).toBe('app.select_under')
    expect(other!.name).toBe('app.select_other')
    expect(under!.permission).toBe('read')
    expect(other!.permission).toBe('read')
    const listed = await under!.run(under!.input.parse({ x: 80, y: 60 }) as never, {} as never)
    expect(a.call).toHaveBeenLastCalledWith('select.under', { x: 80, y: 60 })
    expect(listed.summary).toBe('3 under the spot: 0: Straight edge on Bracket; 1: Top face on Bracket; 2: Body on Bracket')
    expect((listed.output as SelectUnder).candidates).toEqual(CANDIDATES)
    const picked = await other!.run(other!.input.parse({ x: 80, y: 60, index: 1 }) as never, {} as never)
    expect(a.call).toHaveBeenLastCalledWith('select.other', { x: 80, y: 60, index: 1 })
    expect(picked.summary).toBe('Selected Top face on Bracket. The selection reads: 1 face on Bracket.')
    expect((picked.output as SelectPicked).selection).toEqual(a.selection())
    // a bed point instead of view pixels
    await other!.run(other!.input.parse({ pointMm: [1, 2, 3], index: 2 }) as never, {} as never)
    expect(a.call).toHaveBeenLastCalledWith('select.other', { pointMm: [1, 2, 3], index: 2 })
    expect(a.selection().readout).toBe('Bracket')
  })

  it('say so when nothing is under the spot', async () => {
    const [under] = appSelectTools({ call: async () => ({ at: { x: 1, y: 1 }, view: { width: 800, height: 600 }, candidates: [] }) } as unknown as AppLinkCaller, 'SlicerX')
    expect((await under!.run(under!.input.parse({ x: 1, y: 1 }) as never, {} as never)).summary).toBe('Nothing under that spot.')
  })

  it('check the spot and the index before anything leaves', () => {
    const [under, other] = appSelectTools({ call: vi.fn() } as unknown as AppLinkCaller, 'SlicerX')
    for (const bad of [{}, { x: 1 }, { x: -1, y: 2 }, { x: 1, y: 2, pointMm: [0, 0, 0] }, { pointMm: [0, 0] }, { x: '1', y: 2 }]) expect(under!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const good of [{ x: 0, y: 0 }, { pointMm: [1, 2, 3] }]) expect(under!.input.safeParse(good).success, JSON.stringify(good)).toBe(true)
    for (const bad of [{ x: 1, y: 2 }, { x: 1, y: 2, index: -1 }, { x: 1, y: 2, index: 1.5 }, { index: 0 }]) expect(other!.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(other!.input.safeParse({ x: 1, y: 2, index: 0 }).success).toBe(true)
  })

  it("say how to reach the app while the link is off or missing, and keep the app's own refusals", async () => {
    const [none] = appSelectTools(undefined, 'SlicerX')
    expect(((await none!.run({ x: 1, y: 1 } as never, {} as never).catch((x: unknown) => x)) as ToolInputError).code).toBe('not_configured')
    for (const code of ['app_link_off', 'app_closed', 'forbidden']) {
      const [under] = appSelectTools({ call: refuse(code) }, 'SlicerX')
      const e = (await under!.run({ x: 1, y: 1 } as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e.code, code).toBe('not_configured')
      expect(e.message, code).toMatch(/SlicerX is closed/)
    }
    for (const [code, want] of [['invalid_input', 'invalid_input'], ['not_ready', 'not_configured'], ['not_found', 'not_supported']] as const) {
      const [, other] = appSelectTools({ call: refuse(code) }, 'SlicerX')
      const e = (await other!.run({ x: 1, y: 1, index: 0 } as never, {} as never).catch((x: unknown) => x)) as ToolInputError
      expect(e, code).toBeInstanceOf(ToolInputError)
      expect(e.code, code).toBe(want)
    }
  })
})
