// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft section under two nozzle lines across is named when it is made, by geom.loft and by design.edit_step's section
// edit, and never refused. A ship's bow drawn 1.2 mm wide at the deck and 0.42 mm at the keel read 0.75 mm in
// design.check only after its deck houses were on; the same bow now gets a note at the loft. A narrow end on a taper (a
// stern) gets the note too, though design.check may read such an end as a tip, which is why it is a note and not a
// refusal.
// A pointed keel is a tip, not a thin wall, and a cut or a thickened shell is left to its own reading.
import type { Design, DesignHost, StepParams } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { loopOutline, outlineWidth, thinSectionNote, thinSections } from '../src/section-width'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const across = (x: number) => ({ origin: [x, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] })

// a ship's bow as a stage 1 run drew it: 1.2 mm at the deck (z 21), 0.42 mm at the keel (z 12)
const BOW = [[-0.6, 21], [0.6, 21], [0.58, 16.95], [0.45, 13.8], [0.21, 12], [-0.21, 12], [-0.45, 13.8], [-0.58, 16.95]]
// a hull section 10 mm wide with a pointed keel
const KEEL = [[-5, 10], [5, 10], [4.5, 5], [2, 1], [0, 0], [-2, 1], [-4.5, 5]]
// a stern 0.6 mm across, 10 mm tall
const STERN = [[-0.3, 10], [0.3, 10], [0.3, 2], [0, 1.5], [-0.3, 2]]
const box = (w: number, h: number) => [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]]
const profile = (x: number, points: number[][]) => ({ frame: across(x), loops: [{ points }] })

function host() {
  const cube = { name: 'Body', slot: 1, positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] }
  const d: Design = { id: 'd1', name: 'Ship', history: { version: 1, base: [], steps: [] }, transform: I, parts: [], status: [], madeBy: {}, redo: [] }
  const add = vi.fn(async (_d: Design, part: number, params: StepParams) => {
    const step = { id: `s${d.history.steps.length}`, part, transform: I, params }
    d.history = { ...d.history, steps: [...d.history.steps, step] }
    d.parts = [cube]
    d.status = d.history.steps.map(() => ({ state: 'ok' }) as never)
    return step
  })
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: () => d,
    list: () => [d],
    add,
    replay: async (x) => {
      x.parts = [cube]
      x.status = x.history.steps.map(() => ({ state: 'ok' }) as never)
    },
  }
  const tools = designToolset(h, {}, { nozzleMm: () => 0.4 })
  const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never) as Promise<{ summary: string; output: Record<string, unknown> }>
  return { d, run }
}

describe('how thin a loft section is across', () => {
  it('reads the bow at its keel, under two nozzle lines', () => {
    const w = outlineWidth(BOW.map(([a, b]) => [a!, b!] as const), 0.8)!
    expect(w).toBeGreaterThan(0.4)
    expect(w).toBeLessThan(0.5)
  })

  it('reads a pointed keel as a tip, not a wall', () => {
    expect(thinSections([{ loops: [{ points: KEEL as [number, number][] }] }], 0.4)).toEqual([])
  })

  it('reads a circle by its diameter and a chain of lines and splines by its points, and leaves a loop drawn by turns alone', () => {
    expect(thinSections([{ loops: [{ type: 'circle', center: [0, 0], diameterMm: 0.6 }] }], 0.4)).toEqual([{ index: 1, of: 1, mm: 0.6 }])
    const chain = { start: [-0.25, 9.35] as [number, number], segments: [{ type: 'line' as const, to: [0.25, 9.35] as [number, number] }, { type: 'spline' as const, points: [[0.2, 6], [0, 1.1], [-0.2, 6]] as [number, number][], to: [-0.25, 9.35] as [number, number] }] }
    expect(thinSections([{ loops: [chain] }], 0.4)[0]!.mm).toBeLessThan(0.5)
    expect(loopOutline({ start: [0, 0], segments: [{ type: 'line', lengthMm: 5, angleDeg: 0 }] })).toBeNull()
  })

  it('holds the floor to two lines of the nozzle given', () => {
    const sq = [{ loops: [{ points: box(1, 5) as [number, number][] }] }]
    expect(thinSections(sq, 0.4)).toEqual([])
    expect(thinSections(sq, 0.6)).toEqual([{ index: 1, of: 1, mm: 1 }])
  })
})

describe('the note from the loft and the section edit', () => {
  it('says its sentence word for word, with only the numbers from the case', () => {
    expect(thinSectionNote({ index: 9, of: 9, mm: 0.46 }, 0.8, 0.4)).toBe('Section 9 of 9 is 0.46 mm across at its narrowest, under the 0.8 mm a 0.4 mm nozzle prints (two lines). Widen it there, or leave it if another body covers that edge.')
  })

  it('names the thinnest of several thin sections in that sentence, and lists every one', async () => {
    const { run } = host()
    const out = await run('geom.loft', { design: 'd1', profiles: [profile(0, box(0.7, 5)), profile(10, box(6, 5)), profile(20, box(0.5, 5))] })
    expect(out.summary).toContain('Section 3 of 3 is 0.5 mm across at its narrowest, under the 0.8 mm a 0.4 mm nozzle prints (two lines). Widen it there, or leave it if another body covers that edge.')
    expect(out.output['thinSections']).toEqual([{ index: 3, of: 3, mm: 0.5 }, { index: 1, of: 3, mm: 0.7 }])
  })

  it('names the bow on the loft that makes it, keeps the step, and gives the sections', async () => {
    const { d, run } = host()
    const out = await run('geom.loft', { design: 'd1', smooth: true, profiles: [profile(190, box(15, 21)), profile(205, box(7, 21)), profile(214, BOW)] })
    expect(d.history.steps).toHaveLength(1)
    expect(out.summary).toContain(thinSectionNote({ index: 3, of: 3, mm: (out.output['thinSections'] as { mm: number }[])[0]!.mm }, 0.8, 0.4))
    expect(out.output['thinSections']).toEqual([{ index: 3, of: 3, mm: expect.any(Number) }])
  })

  it('names a narrow stern at the end of a taper as a note, and keeps the step', async () => {
    const { d, run } = host()
    const out = await run('geom.loft', { design: 'd1', profiles: [profile(0.5, STERN), profile(8, box(9, 10)), profile(25, box(18, 10))] })
    expect(d.history.steps).toHaveLength(1)
    expect(out.summary).toMatch(/Section 1 of 3 is 0\.\d+ mm across at its narrowest/)
  })

  it('says nothing of a hull with a pointed keel, of a cut, or of a thickened shell', async () => {
    const { run } = host()
    expect((await run('geom.loft', { design: 'd1', profiles: [profile(0, KEEL), profile(20, KEEL)] })).summary).not.toMatch(/across at its narrowest/)
    expect((await run('geom.loft', { design: 'd1', operation: 'cut', part: 0, profiles: [profile(0, box(0.5, 3)), profile(5, box(0.5, 3))] })).summary).not.toMatch(/across at its narrowest/)
    expect((await run('geom.loft', { design: 'd1', thicken: { thicknessMm: 1 }, profiles: [profile(0, box(0.5, 3)), profile(5, box(0.5, 3))] })).summary).not.toMatch(/across at its narrowest/)
  })

  it('names a station a section edit leaves under two nozzle lines, and keeps the edit', async () => {
    const { d, run } = host()
    const made = await run('geom.loft', { design: 'd1', profiles: [profile(0, box(6, 10)), profile(30, box(12, 10)), profile(60, box(12, 10))] })
    expect(made.summary).not.toMatch(/across at its narrowest/)
    const out = await run('design.edit_step', { design: 'd1', step: 1, section: { station: 'front', width: 0.6 } })
    expect(out.summary).toMatch(/is 0\.6 mm across at its narrowest/)
    expect(out.output['thinSections']).toEqual([{ index: expect.any(Number), of: 3, mm: 0.6 }])
    expect(d.history.steps).toHaveLength(1)
  })
})
