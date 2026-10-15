// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Model's Select Other: the list of everything under a spot runs the edge a click picks first, then the faces front to
// back, then the bodies; a plain click on the same spot again steps through them and around, a double click does not,
// and anything picked in between starts over; a hold opens the list; clients list and pick through the app link.
import type { PickAllHit } from '@slicerx/viewport'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_LINK_METHODS, LinkError, runCall } from '../src/app-link/methods'
import { otherView, selectOther, selectOtherOn, setOtherView, type OtherCandidate, type OtherView } from '../src/plate/select-other'
import { applyCandidate, buildCandidates, candidateIndex, candidatesKey, clickAt, clickStep, faceLabel, forgetClick, holdAt, selectionSig, type ClickMemo } from '../src/plate/select-other-pick'
import { get, set, type AppState, type SubPick } from '../src/state/store'

type Vec3 = [number, number, number]

const hit = (objectId: string, triangle: number, patch: number, depth: number, normal: Vec3 = [0, 0, 1]): PickAllHit => ({ objectId, partIndex: 0, triangle, patch, point: [triangle, 0, 0], depth, normal })

/** Bracket's top in front, its far wall behind, then Plate's front face: two objects under one spot. */
const HITS = [hit('a', 4, 2, 10), hit('a', 9, 8, 30, [0, 1, 0]), hit('b', 21, 20, 50, [0, -1, 0])]
const NAMES = { a: 'Bracket', b: 'Plate' }
const LINE = [{ from: [0, 0, 0] as Vec3, to: [10, 0, 0] as Vec3 }]

const order = (l: readonly OtherCandidate[]) => l.map((c) => `${c.kind} ${c.label} on ${c.object}`)

describe('the list', () => {
  it('leads with the edge a click picks, then the faces front to back, then the bodies', () => {
    expect(order(buildCandidates({ hits: HITS, edge: { lines: LINE, near: true }, filter: ['face'], names: NAMES }))).toEqual([
      'edge Straight edge on Bracket',
      'face Top face on Bracket',
      'face Back face on Bracket',
      'face Front face on Plate',
      'body Body on Bracket',
      'body Body on Plate',
    ])
  })

  it('leaves out an edge too far from the pointer to win, as a click does', () => {
    expect(buildCandidates({ hits: HITS, edge: { lines: LINE, near: false }, filter: ['face'], names: NAMES })[0]).toMatchObject({ kind: 'face', triangle: 4 })
  })

  it('with Edge only lists the edge wherever the pointer is on its face, then the bodies; with Body the bodies alone', () => {
    expect(order(buildCandidates({ hits: HITS, edge: { lines: [...LINE, ...LINE], near: false }, filter: ['edge'], names: NAMES }))).toEqual(['edge Round edge on Bracket', 'body Body on Bracket', 'body Body on Plate'])
    expect(order(buildCandidates({ hits: HITS, edge: null, filter: ['object'], names: NAMES }))).toEqual(['body Body on Bracket', 'body Body on Plate'])
    expect(buildCandidates({ hits: [], edge: null, filter: ['face'], names: NAMES })).toEqual([])
  })

  it('names faces by the way they face, and round ones as round', () => {
    expect([faceLabel([0, 0, 1]), faceLabel([0, 0, -1]), faceLabel([0, -1, 0]), faceLabel([0, 1, 0]), faceLabel([-1, 0, 0]), faceLabel([1, 0, 0]), faceLabel([0, -0.7, 0.7]), faceLabel([1, 0, 0], true)]).toEqual([
      'Top face',
      'Bottom face',
      'Front face',
      'Back face',
      'Left face',
      'Right face',
      'Sloped face',
      'Round face',
    ])
    const round = buildCandidates({ hits: HITS, edge: null, filter: ['face'], names: NAMES, round: new Set(['a:0:8']) })
    expect(round[1]).toMatchObject({ label: 'Round face', round: true })
  })

  it('keeps one key for the same things wherever on each face the pointer is', () => {
    const a = buildCandidates({ hits: HITS, edge: null, filter: ['face'], names: NAMES })
    const b = buildCandidates({ hits: [{ ...HITS[0]!, triangle: 5 }, ...HITS.slice(1)], edge: null, filter: ['face'], names: NAMES })
    expect(candidatesKey(a)).toBe(candidatesKey(b))
    expect(candidatesKey(a)).not.toBe(candidatesKey(buildCandidates({ hits: HITS.slice(1), edge: null, filter: ['face'], names: NAMES })))
  })

  it('finds the candidate the selection is now', () => {
    const l = buildCandidates({ hits: HITS, edge: { lines: LINE, near: true }, filter: ['face'], names: NAMES })
    const pick = (kind: 'face' | 'edge', triangle: number, lines?: typeof LINE): SubPick => ({ kind, objectId: 'a', partIndex: 0, triangle, point: [0, 0, 0], ...(lines ? { lines } : {}) })
    expect(candidateIndex(l, { subPicks: [pick('edge', 4, [{ from: LINE[0]!.to, to: LINE[0]!.from }])], selectedIds: ['a'] })).toBe(0)
    expect(candidateIndex(l, { subPicks: [pick('face', 9)], selectedIds: ['a'] })).toBe(2)
    expect(candidateIndex(l, { subPicks: [], selectedIds: ['b'] })).toBe(5)
    expect(candidateIndex(l, { subPicks: [pick('face', 4), pick('face', 9)], selectedIds: ['a'] })).toBe(-1)
  })
})

describe('repeated clicks', () => {
  const memo: ClickMemo = { at: [100, 100], key: 'k', time: 1000, sig: 's' }

  it('step on the same spot, start over elsewhere, after something else is picked or when the list differs', () => {
    expect(clickStep(null, [100, 100], 'k', 2000, 's')).toBe('fresh')
    expect(clickStep(memo, [103, 102], 'k', 2000, 's')).toBe('step')
    expect(clickStep(memo, [106, 100], 'k', 2000, 's')).toBe('fresh')
    expect(clickStep(memo, [100, 100], 'other', 2000, 's')).toBe('fresh')
    expect(clickStep(memo, [100, 100], 'k', 2000, 'changed')).toBe('fresh')
  })

  it('leave a double click alone', () => {
    expect(clickStep(memo, [100, 100], 'k', 1200, 's')).toBe('double')
  })
})

/** A view with HITS under (100, 100) and nothing elsewhere; the edge lies 3 px from that spot on screen. */
function fakeView(over: Partial<OtherView> = {}): OtherView {
  return {
    pickAll: (x, y) => (Math.hypot(x - 100, y - 100) <= 5 ? HITS : []),
    edgeAt: async () => LINE,
    faceRound: async () => false,
    screenOf: (p) => [100 + p[0] * 0.3, 103],
    rect: () => ({ left: 20, top: 40, width: 800, height: 600 }),
    ring: () => undefined,
    pointer: () => null,
    focus: () => undefined,
    ...over,
  }
}

const state = (s: Partial<AppState>) => set(s as AppState)

beforeEach(() => {
  state({ workspace: 'prepare', modelMode: 'design', objectTool: null, settingsMode: 'simple', pickFilter: ['face'], subPicks: [], selection: null, selectedIds: [], plate: [{ id: 'a', name: 'Bracket' }, { id: 'b', name: 'Plate' }] as unknown as AppState['plate'] })
  setOtherView(fakeView())
  forgetClick()
})

afterEach(() => {
  setOtherView(null)
  selectOther.setState({ open: null, hover: null, tag: null })
  vi.restoreAllMocks()
})

describe('in the app', () => {
  it('is on in Model with no tool open', () => {
    expect(selectOtherOn(get())).toBe(true)
    expect(selectOtherOn({ ...get(), objectTool: 'push' })).toBe(false)
    expect(selectOtherOn({ ...get(), modelMode: 'slice' })).toBe(false)
  })

  it('steps through everything under the spot on repeated clicks, and around', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    // the first click picks as any click does: here the edge near the pointer
    const first = vi.fn(async () => applyCandidate(buildCandidates({ hits: HITS, edge: { lines: LINE, near: true }, filter: ['face'], names: NAMES })[0]!))
    const ev = { objectId: 'a', partIndex: 0, triangle: 4, point: [0, 0, 0] as Vec3, bed: null, screen: [100, 100] as [number, number] }
    await clickAt(ev, first)
    expect(first).toHaveBeenCalledTimes(1)
    expect(get().subPicks.map((p) => p.kind)).toEqual(['edge'])
    expect(selectOther.getState().tag).toMatchObject({ label: 'Straight edge on Bracket', index: 0, count: 6 })
    const seen: string[] = []
    for (let i = 0; i < 6; i++) {
      now += 500
      await clickAt({ ...ev, screen: [101, 102] }, first)
      const t = selectOther.getState().tag!
      seen.push(`${t.index + 1} of ${t.count}: ${t.label}`)
    }
    expect(first).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['2 of 6: Top face on Bracket', '3 of 6: Back face on Bracket', '4 of 6: Front face on Plate', '5 of 6: Body on Bracket', '6 of 6: Body on Plate', '1 of 6: Straight edge on Bracket'])
    // a body: nothing on it, the object selected
    now += 500
    await clickAt(ev, first)
    now += 500
    await clickAt(ev, first)
    now += 500
    await clickAt(ev, first)
    now += 500
    await clickAt(ev, first)
    expect(get().subPicks).toEqual([])
    expect(get().selectedIds).toEqual(['a'])
  })

  it('keeps the pick on a double click, and starts over after a pick elsewhere', async () => {
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const first = vi.fn(async () => applyCandidate(buildCandidates({ hits: HITS, edge: { lines: LINE, near: true }, filter: ['face'], names: NAMES })[0]!))
    const ev = { objectId: 'a', partIndex: 0, triangle: 4, point: [0, 0, 0] as Vec3, bed: null, screen: [100, 100] as [number, number] }
    await clickAt(ev, first)
    now += 120
    await clickAt(ev, first)
    expect(get().subPicks.map((p) => p.kind)).toEqual(['edge'])
    expect(first).toHaveBeenCalledTimes(1)
    // something else picked in between: the same spot starts over with a plain click
    set({ subPicks: [], selection: 'b', selectedIds: ['b'] })
    now += 1000
    await clickAt(ev, first)
    expect(first).toHaveBeenCalledTimes(2)
    expect(selectionSig(get())).toContain('edge:a')
  })

  it('opens the list on a hold over the model, and nothing off it', async () => {
    await holdAt([100, 100], false)
    expect(selectOther.getState().open?.list.map((c) => c.label)).toEqual(['Straight edge', 'Top face', 'Back face', 'Front face', 'Body', 'Body'])
    selectOther.setState({ open: null })
    await holdAt([400, 400], true)
    expect(selectOther.getState().open).toBeNull()
  })
})

describe('the app link', () => {
  const refused = async (method: string, args: Record<string, unknown>) => {
    const e = await runCall(method, args).catch((x: unknown) => x)
    expect(e, JSON.stringify(args)).toBeInstanceOf(LinkError)
    return (e as LinkError).code
  }

  it('reads, since a pick changes what is selected and never the project', () => {
    expect(APP_LINK_METHODS['select.under']).toBe('read')
    expect(APP_LINK_METHODS['select.other']).toBe('read')
  })

  it('lists everything under a spot in view pixels, and picks one by index with the selection read back', async () => {
    const under = (await runCall('select.under', { x: 80, y: 60 })) as { at: unknown; view: unknown; candidates: { index: number; kind: string; label: string; object: string }[] }
    expect(under.at).toEqual({ x: 80, y: 60 })
    expect(under.view).toEqual({ width: 800, height: 600 })
    expect(under.candidates.map((c) => `${c.index} ${c.label} on ${c.object}`)).toEqual(['0 Straight edge on Bracket', '1 Top face on Bracket', '2 Back face on Bracket', '3 Front face on Plate', '4 Body on Bracket', '5 Body on Plate'])
    const picked = (await runCall('select.other', { x: 80, y: 60, index: 3 })) as { picked: { label: string; objectId: string }; selection: { readout: string; selectedIds: string[]; picks: { kind: string; triangle: number }[] } }
    expect(picked.picked).toMatchObject({ label: 'Front face', objectId: 'b' })
    expect(picked.selection).toEqual({ readout: '1 face on Plate', selectedIds: ['b'], picks: [{ kind: 'face', objectId: 'b', part: 0, triangle: 21 }] })
    expect(get().subPicks.map((p) => p.triangle)).toEqual([21])
    const body = (await runCall('select.other', { x: 80, y: 60, index: 4 })) as { selection: { readout: string } }
    expect(body.selection.readout).toBe('Bracket')
  })

  it('aims at a bed point too', async () => {
    setOtherView(fakeView({ screenOf: (p) => [p[0] + 100, p[1] + 100] }))
    const under = (await runCall('select.under', { pointMm: [0, 0, 5] })) as { at: unknown; candidates: unknown[] }
    expect(under.at).toEqual({ x: 80, y: 60 })
    expect(under.candidates.length).toBe(6)
  })

  it('refuses a bad spot or index and anything outside Model, changing nothing', async () => {
    expect(await refused('select.other', { x: 80, y: 60, index: 6 })).toBe('invalid_input')
    expect(await refused('select.other', { x: 80, y: 60 })).toBe('invalid_input')
    expect(await refused('select.other', { x: 80, y: 60, index: 1.5 })).toBe('invalid_input')
    expect(await refused('select.under', { x: 900, y: 60 })).toBe('invalid_input')
    expect(await refused('select.under', { x: 80 })).toBe('invalid_input')
    expect(await refused('select.under', { x: 80, y: 60, plate: 2 })).toBe('invalid_input')
    expect(await refused('select.under', { x: 80, y: 60, index: 0 })).toBe('invalid_input')
    expect(await refused('select.under', { pointMm: [1, 2] })).toBe('invalid_input')
    expect(get().subPicks).toEqual([])
    set({ objectTool: 'push' })
    expect(await refused('select.under', { x: 80, y: 60 })).toBe('not_ready')
    set({ objectTool: null })
    setOtherView(null)
    expect(otherView()).toBeNull()
    expect(await refused('select.other', { x: 80, y: 60, index: 0 })).toBe('not_ready')
  })
})
