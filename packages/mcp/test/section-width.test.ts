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

// the last two sections of three recorded hull lofts, as their histories hold them: a bow the check fails at 0.75 mm, a
// stern the check passes at 1.12 mm (0.52 mm at its end face, 0.845 mm 0.4 mm in), and a stem the check fails at 0.36 mm
const RUN1_BOW = [{ frame: { origin: [205, 0, 0], normal: [1, 0, 0] }, loops: [{ points: [[-3.5, 20.5], [3.5, 20.5], [3.36, 13.98], [2.63, 8.9], [1.23, 6], [-1.23, 6], [-2.63, 8.9], [-3.36, 13.98]] }] }, { frame: { origin: [214, 0, 0], normal: [1, 0, 0] }, loops: [{ points: BOW }] }]
const RUN2_STERN = [{ frame: { origin: [0.5, 0, 0], normal: [1, 0, 0] }, loops: [{ points: [[-0.5, 15.5], [0.5, 15.5], [0.5, 13.3], [0.45, 11.65], [0.25, 10], [-0.25, 10], [-0.45, 11.65], [-0.5, 13.3]] }] }, { frame: { origin: [8, 0, 0], normal: [1, 0, 0] }, loops: [{ points: [[-4.5, 15.2], [4.5, 15.2], [4.5, 11.12], [4.05, 8.06], [2.25, 5], [-2.25, 5], [-4.05, 8.06], [-4.5, 11.12]] }] }]
const spline = (top: number[], points: number[][]) => ({ start: [-top[0]!, top[1]!], segments: [{ type: 'line', to: [top[0]!, top[1]!] }, { type: 'spline', to: [-top[0]!, top[1]!], points }] })
const SHIP_STEM = [
  { frame: { origin: [184, 128, 0], normal: [1, 0, 0] }, loops: [spline([3.2, 9.1], [[3.093, 7.913], [2.785, 6.209], [2.305, 4.413], [1.704, 2.762], [1.051, 1.442], [0.431, 0.593], [0, 0.3], [-0.431, 0.593], [-1.051, 1.442], [-1.704, 2.762], [-2.305, 4.413], [-2.785, 6.209], [-3.093, 7.913]])] },
  { frame: { origin: [190, 128, 0], normal: [1, 0, 0] }, loops: [spline([0.25, 9.35], [[0.239, 8.813], [0.207, 7.542], [0.16, 5.855], [0.106, 4.076], [0.055, 2.525], [0.016, 1.472], [0, 1.1], [-0.016, 1.472], [-0.055, 2.525], [-0.106, 4.076], [-0.16, 5.855], [-0.207, 7.542], [-0.239, 8.813]])] },
] as never[]

describe('a thin end section that is only the taper of the end', () => {
  it('still names the recorded bow and stem the check fails, and no longer the stern it passes', () => {
    expect(thinSections(RUN1_BOW as never, 0.4)).toEqual([{ index: 2, of: 2, mm: 0.48 }])
    expect(thinSections(SHIP_STEM, 0.4)).toEqual([{ index: 2, of: 2, mm: 0.04 }])
    expect(thinSections(RUN2_STERN as never, 0.4)).toEqual([])
  })

  it('reads only the first and last sections as ends, and not a section with no frame', () => {
    // the same thin box in the middle of a loft is a section of it, never its end
    expect(thinSections([profile(0, box(9, 5)), profile(7.5, box(0.6, 5)), profile(15, box(9, 5))] as never, 0.4)).toEqual([{ index: 2, of: 3, mm: 0.6 }])
    expect(thinSections([{ loops: [{ points: box(0.6, 5) }] }, { loops: [{ points: box(9, 5) }] }] as never, 0.4)).toEqual([{ index: 1, of: 2, mm: 0.6 }])
  })
})

describe('the note from the loft and the section edit', () => {
  it('says its sentence word for word, with only the numbers from the case', () => {
    expect(thinSectionNote({ index: 9, of: 9, mm: 0.46 }, 0.8, 0.4)).toBe('Section 9 of 9 is 0.46 mm across at its narrowest, under the 0.8 mm a 0.4 mm nozzle prints (two lines). Widen it there, or leave it if another body covers that edge.')
  })

  it('names the thinnest of several thin sections in that sentence, and lists every one', async () => {
    const { run } = host()
    // the middle section narrow too, so neither end widens past the floor a nozzle width in (endTaper)
    const out = await run('geom.loft', { design: 'd1', profiles: [profile(0, box(0.7, 5)), profile(10, box(2, 5)), profile(20, box(0.5, 5))] })
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

  it('names a narrow stern that stays under the floor a nozzle width in as a note, and keeps the step', async () => {
    const { d, run } = host()
    // 0.6 mm at the end, and only 0.62 mm a nozzle width in toward a section 1 mm wide 7.5 mm away
    const out = await run('geom.loft', { design: 'd1', profiles: [profile(0.5, STERN), profile(8, box(1, 10)), profile(25, box(18, 10))] })
    expect(d.history.steps).toHaveLength(1)
    expect(out.summary).toMatch(/Section 1 of 3 is 0\.\d+ mm across at its narrowest/)
  })

  it('says nothing of a narrow stern that is the taper of the end: past the floor a nozzle width in', async () => {
    const { d, run } = host()
    // 0.6 mm at the end, and 1.05 mm a nozzle width in toward a section 9 mm wide 7.5 mm away
    const out = await run('geom.loft', { design: 'd1', profiles: [profile(0.5, STERN), profile(8, box(9, 10)), profile(25, box(18, 10))] })
    expect(d.history.steps).toHaveLength(1)
    expect(out.summary).not.toMatch(/across at its narrowest/)
    expect(out.output['thinSections']).toBeUndefined()
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
