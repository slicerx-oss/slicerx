// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A loft section whose arc dips under the section's lowest drawn point is named when geom.loft makes the loft, and the
// loft is never refused or changed: the body follows the arc, so it sits lower than every point the section names. Run b6r drew its bilges as arcs into a flat keel line through points that do not meet
// the line level, and its hull went 0.118 mm under the bed. Run 3's arcs bottom out at their ends and get no note.
import type { Design, DesignHost, StepParams } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { arcDipNote, arcDips } from '../src/arc-dip'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

// run b6r's nine hull sections as it sent them: sections 3 to 7 draw each bilge as an arc into the keel line
const B6R = [
  {"frame": {"origin": [0, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-1.4, 16.5], "segments": [{"type": "line", "to": [1.4, 16.5]}, {"type": "line", "to": [1.4, 9]}, {"type": "arc", "to": [0.84, 5], "through": [1.3, 6.2]}, {"type": "line", "to": [-0.84, 5]}, {"type": "arc", "to": [-1.4, 9], "through": [-1.3, 6.2]}, {"type": "line", "to": [-1.4, 16.5]}]}]},
  {"frame": {"origin": [6, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-5, 15.8], "segments": [{"type": "line", "to": [5, 15.8]}, {"type": "line", "to": [5, 6.5]}, {"type": "arc", "to": [3, 2.5], "through": [4.65, 3.7]}, {"type": "line", "to": [-3, 2.5]}, {"type": "arc", "to": [-5, 6.5], "through": [-4.65, 3.7]}, {"type": "line", "to": [-5, 15.8]}]}]},
  {"frame": {"origin": [20, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-9.5, 15], "segments": [{"type": "line", "to": [9.5, 15]}, {"type": "line", "to": [9.5, 4.6]}, {"type": "arc", "to": [5.7, 0.6], "through": [8.84, 1.8]}, {"type": "line", "to": [-5.7, 0.6]}, {"type": "arc", "to": [-9.5, 4.6], "through": [-8.84, 1.8]}, {"type": "line", "to": [-9.5, 15]}]}]},
  {"frame": {"origin": [50, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-11.2, 14.7], "segments": [{"type": "line", "to": [11.2, 14.7]}, {"type": "line", "to": [11.2, 4]}, {"type": "arc", "to": [6.72, 0], "through": [10.42, 1.2]}, {"type": "line", "to": [-6.72, 0]}, {"type": "arc", "to": [-11.2, 4], "through": [-10.42, 1.2]}, {"type": "line", "to": [-11.2, 14.7]}]}]},
  {"frame": {"origin": [110, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-11.2, 14.7], "segments": [{"type": "line", "to": [11.2, 14.7]}, {"type": "line", "to": [11.2, 4]}, {"type": "arc", "to": [6.72, 0], "through": [10.42, 1.2]}, {"type": "line", "to": [-6.72, 0]}, {"type": "arc", "to": [-11.2, 4], "through": [-10.42, 1.2]}, {"type": "line", "to": [-11.2, 14.7]}]}]},
  {"frame": {"origin": [160, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-11.2, 14.7], "segments": [{"type": "line", "to": [11.2, 14.7]}, {"type": "line", "to": [11.2, 4]}, {"type": "arc", "to": [6.72, 0], "through": [10.42, 1.2]}, {"type": "line", "to": [-6.72, 0]}, {"type": "arc", "to": [-11.2, 4], "through": [-10.42, 1.2]}, {"type": "line", "to": [-11.2, 14.7]}]}]},
  {"frame": {"origin": [190, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-9.5, 14.5], "segments": [{"type": "line", "to": [9.5, 14.5]}, {"type": "line", "to": [9.5, 4.6]}, {"type": "arc", "to": [5.7, 0.6], "through": [8.84, 1.8]}, {"type": "line", "to": [-5.7, 0.6]}, {"type": "arc", "to": [-9.5, 4.6], "through": [-8.84, 1.8]}, {"type": "line", "to": [-9.5, 14.5]}]}]},
  {"frame": {"origin": [207, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-6, 14.2], "segments": [{"type": "line", "to": [6, 14.2]}, {"type": "line", "to": [6, 6.5]}, {"type": "arc", "to": [3.6, 2.5], "through": [5.58, 3.7]}, {"type": "line", "to": [-3.6, 2.5]}, {"type": "arc", "to": [-6, 6.5], "through": [-5.58, 3.7]}, {"type": "line", "to": [-6, 14.2]}]}]},
  {"frame": {"origin": [215, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-3, 14], "segments": [{"type": "line", "to": [3, 14]}, {"type": "line", "to": [3, 9]}, {"type": "arc", "to": [1.8, 5], "through": [2.79, 6.2]}, {"type": "line", "to": [-1.8, 5]}, {"type": "arc", "to": [-3, 9], "through": [-2.79, 6.2]}, {"type": "line", "to": [-3, 14]}]}]},
] as never[]

// run 3's nine hull sections: its arcs bottom out at their ends
const RUN3 = [
  {"frame": {"origin": [-109, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-3, 16.5], "segments": [{"type": "line", "to": [3, 16.5]}, {"type": "arc", "to": [1.8, 3], "through": [2.95, 11.1]}, {"type": "line", "to": [-1.8, 3]}, {"type": "arc", "to": [-3, 16.5], "through": [-2.95, 11.1]}]}]},
  {"frame": {"origin": [-98, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-7.5, 16.3], "segments": [{"type": "line", "to": [7.5, 16.3]}, {"type": "arc", "to": [4.5, 1.5], "through": [7.3, 10.4]}, {"type": "line", "to": [-4.5, 1.5]}, {"type": "arc", "to": [-7.5, 16.3], "through": [-7.3, 10.4]}]}]},
  {"frame": {"origin": [-75, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-10.5, 16], "segments": [{"type": "line", "to": [10.5, 16]}, {"type": "arc", "to": [6.3, 0], "through": [10.3, 9.6]}, {"type": "line", "to": [-6.3, 0]}, {"type": "arc", "to": [-10.5, 16], "through": [-10.3, 9.6]}]}]},
  {"frame": {"origin": [-40, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-11.5, 16], "segments": [{"type": "line", "to": [11.5, 16]}, {"type": "arc", "to": [6.9, 0], "through": [11.3, 9.6]}, {"type": "line", "to": [-6.9, 0]}, {"type": "arc", "to": [-11.5, 16], "through": [-11.3, 9.6]}]}]},
  {"frame": {"origin": [0, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-11.5, 16], "segments": [{"type": "line", "to": [11.5, 16]}, {"type": "arc", "to": [6.9, 0], "through": [11.3, 9.6]}, {"type": "line", "to": [-6.9, 0]}, {"type": "arc", "to": [-11.5, 16], "through": [-11.3, 9.6]}]}]},
  {"frame": {"origin": [45, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-11.2, 16], "segments": [{"type": "line", "to": [11.2, 16]}, {"type": "arc", "to": [6.7, 0], "through": [11, 9.6]}, {"type": "line", "to": [-6.7, 0]}, {"type": "arc", "to": [-11.2, 16], "through": [-11, 9.6]}]}]},
  {"frame": {"origin": [80, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-8.5, 16.8], "segments": [{"type": "line", "to": [8.5, 16.8]}, {"type": "arc", "to": [5.1, 0.5], "through": [8.3, 10.3]}, {"type": "line", "to": [-5.1, 0.5]}, {"type": "arc", "to": [-8.5, 16.8], "through": [-8.3, 10.3]}]}]},
  {"frame": {"origin": [100, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-4.5, 17.3], "segments": [{"type": "line", "to": [4.5, 17.3]}, {"type": "arc", "to": [2.7, 3], "through": [4.4, 11.6]}, {"type": "line", "to": [-2.7, 3]}, {"type": "arc", "to": [-4.5, 17.3], "through": [-4.4, 11.6]}]}]},
  {"frame": {"origin": [109, 0, 0], "normal": [1, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1]}, "loops": [{"start": [-1.6, 17.8], "segments": [{"type": "line", "to": [1.6, 17.8]}, {"type": "arc", "to": [1, 8], "through": [1.55, 13.9]}, {"type": "line", "to": [-1, 8]}, {"type": "arc", "to": [-1.6, 17.8], "through": [-1.55, 13.9]}]}]},
] as never[]

const TANGENT_THROUGH = [9.9082, 1.3206]

/** Run b6r's middle section with its port bilge arc run level into the keel: through a point on the circle that meets it. */
const level = () => {
  const s = JSON.parse(JSON.stringify(B6R[3])) as { loops: { segments: { through?: number[] }[] }[] }
  s.loops[0]!.segments[2]!.through = TANGENT_THROUGH
  return s
}

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

const SENTENCE = "Section 4 of 9 dips 0.12 mm under its lowest drawn point: the arc ending at (6.72, 0) bottoms out before it gets there, and the body follows it. Move that arc's through point so it runs level into (6.72, 0), tangent to the line it meets, or draw that stretch as a line."

describe('arcs that dip under their section', () => {
  it('says its sentence word for word, with only the numbers from the case', () => {
    expect(arcDipNote({ index: 4, of: 9, mm: 0.12, end: [6.72, 0] })).toBe(SENTENCE)
  })

  it('finds run b6r\'s bilge arcs under its keel line, deepest first', () => {
    expect(arcDips(B6R)).toEqual([
      { index: 4, of: 9, mm: 0.12, end: [6.72, 0] },
      { index: 5, of: 9, mm: 0.12, end: [6.72, 0] },
      { index: 6, of: 9, mm: 0.12, end: [6.72, 0] },
      { index: 3, of: 9, mm: 0.04, end: [5.7, 0.6] },
      { index: 7, of: 9, mm: 0.04, end: [5.7, 0.6] },
    ])
  })

  it('finds none in run 3, whose arcs bottom out at their ends, nor in an arc run level into its line', () => {
    expect(arcDips(RUN3)).toEqual([])
    // the same section with both bilges: the port one level now, the starboard one still dipping
    expect(arcDips([level()] as never)).toEqual([{ index: 1, of: 1, mm: 0.12, end: [-6.72, 0] }])
    const both = level() as { loops: { segments: { through?: number[] }[] }[] }
    both.loops[0]!.segments[4]!.through = [-TANGENT_THROUGH[0]!, TANGENT_THROUGH[1]!]
    expect(arcDips([both] as never)).toEqual([])
  })

  it('reads an arc by its center and sweep, and a section on the bed, which cannot dip under itself', () => {
    const rounded = { start: [4, -5], segments: [{ type: 'line', to: [4, 3] }, { type: 'arc', center: [3, 3], sweepDeg: 90 }, { type: 'line', to: [-3, 4] }, { type: 'line', to: [-3, -5] }] }
    expect(arcDips([{ loops: [rounded] }] as never)).toEqual([])
    // the same outline standing up, its arc bulging under its lowest corner, read by center and sweep
    const standing = { frame: { origin: [0, 0, 0], normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, loops: [{ start: [-4, 4], segments: [{ type: 'line', to: [4, 4] }, { type: 'line', to: [4, 1] }, { type: 'arc', center: [0, 1], sweepDeg: -180 }, { type: 'line', to: [-4, 4] }] }] }
    expect(arcDips([standing] as never)).toEqual([{ index: 1, of: 1, mm: 4, end: [4, 1] }])
  })
})

describe('the note from the loft', () => {
  it('names run b6r\'s deepest arc on the loft that makes it, keeps the step, and lists every one', async () => {
    const { d, run } = host()
    const out = await run('geom.loft', { design: 'd1', smooth: true, profiles: B6R })
    expect(d.history.steps).toHaveLength(1)
    expect(out.summary).toContain(SENTENCE)
    expect((out.output['arcDips'] as unknown[]).length).toBe(5)
  })

  it('says nothing of run 3, of a cut, or of a thickened shell', async () => {
    const { run } = host()
    expect((await run('geom.loft', { design: 'd1', smooth: true, profiles: RUN3 })).summary).not.toMatch(/under its lowest drawn point/)
    expect((await run('geom.loft', { design: 'd1', operation: 'cut', part: 0, smooth: true, profiles: B6R })).summary).not.toMatch(/under its lowest drawn point/)
    expect((await run('geom.loft', { design: 'd1', smooth: true, thicken: { thicknessMm: 1 }, profiles: B6R })).output['arcDips']).toBeUndefined()
  })

  it('has no section edit to name: design.edit_step takes only sections drawn as points, which have no arcs', async () => {
    const { d, run } = host()
    await run('geom.loft', { design: 'd1', smooth: true, profiles: B6R })
    await expect(run('design.edit_step', { design: 'd1', step: 1, section: { station: 'front', width: 3 } })).rejects.toThrow(/its sections have arcs, circles or splines/)
    expect(d.history.steps).toHaveLength(1)
  })
})
