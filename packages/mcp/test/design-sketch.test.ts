// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Finished sketches through the design tools: design.sketch puts one in the host's timeline, and an extrude or revolve
// given its id draws on it and names it. With constraints the host solves the sketch first. Only a host with a
// timeline (the app) has them.
import type { Design, DesignHost, SketchConstraint, SketchItem, StepParams } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const LOOPS = [{ type: 'circle' as const, center: [0, 0] as [number, number], diameterMm: 10 }]
const FRAME = { origin: [0, 0, 5] as [number, number, number], normal: [0, -1, 0] as [number, number, number], u: [1, 0, 0] as [number, number, number], v: [0, 0, 1] as [number, number, number] }

function host(settle?: DesignHost['settleSketch'], engine?: DesignHost['call']) {
  const d: Design = { id: 'd1', name: 'Clip', history: { version: 1, base: [], steps: [] }, transform: I, parts: [], status: [], madeBy: {}, redo: [] }
  const sketches: SketchItem[] = []
  const add = vi.fn(async (_d: Design, part: number, params: StepParams, _l?: string, opts?: { sketch?: string }) => {
    const step = { id: `s${d.history.steps.length}`, part, transform: I, params, ...(opts?.sketch ? { sketch: opts.sketch } : {}) }
    d.history = { ...d.history, steps: [...d.history.steps, step] }
    return step
  })
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: () => d,
    list: () => [d],
    add,
    sketch: (id) => {
      const k = sketches.find((s) => s.id === id)
      if (!k) throw new Error(`no sketch ${id}`)
      return k
    },
    addSketch: (s) => {
      const k: SketchItem = { kind: 'sketch', id: `k${sketches.length + 1}`, name: `Sketch ${sketches.length + 1}`, ...s }
      sketches.push(k)
      return k
    },
    ...(settle ? { settleSketch: settle } : {}),
    ...(engine ? { call: engine } : {}),
  }
  const tools = designToolset(h)
  const run = (name: string, input: Record<string, unknown>) => tools.find((t) => t.name === name)!.run(input as never, {} as never)
  return { d, add, run, sketches }
}

describe('finished sketches in the design tools', () => {
  it('puts a sketch in the timeline, then extrudes and revolves it by id, each step naming it', async () => {
    const { d, add, run } = host()
    const made = await run('design.sketch', { loops: LOOPS, frame: { origin: FRAME.origin, normal: FRAME.normal, u: FRAME.u } })
    expect(made.output).toMatchObject({ id: 'k1', name: 'Sketch 1', loops: 1 })
    await run('geom.extrude', { design: 'd1', sketch: 'k1', distance_mm: 4 })
    const p = add.mock.calls[0]![2] as Extract<StepParams, { op: 'shape.extrude' }>
    expect(p.shape).toEqual({ type: 'sketch', loops: LOOPS })
    expect(p.frame?.normal).toEqual(FRAME.normal)
    expect(add.mock.calls[0]![4]).toEqual({ sketch: 'k1' })
    await run('geom.revolve', { design: 'd1', sketch: 'k1', axis: { point: [20, 0], direction: [0, 1] } })
    expect(add.mock.calls[1]![4]).toEqual({ sketch: 'k1' })
    expect(d.history.steps.map((s) => s.sketch)).toEqual(['k1', 'k1'])
  })

  it('sweeps a finished profile sketch along a finished open path sketch, copying both into the step', async () => {
    const { add, run, sketches } = host()
    await run('design.sketch', { loops: LOOPS, frame: { origin: FRAME.origin, normal: FRAME.normal, u: FRAME.u } })
    const chain = [{ start: [0, 0] as [number, number], segments: [{ type: 'line' as const, to: [0, 20] as [number, number] }, { type: 'arc' as const, center: [10, 20] as [number, number], sweepDeg: -90 }] }]
    await run('design.sketch', { loops: chain, frame: { origin: [0, 0, 0], normal: [0, -1, 0] } })
    await run('geom.sweep', { design: 'd1', profile_sketch: 'k1', path_sketch: 'k2', name: 'Handle' })
    const p = add.mock.calls[0]![2] as Extract<StepParams, { op: 'sketch.sweep' }>
    expect(p.op).toBe('sketch.sweep')
    expect(p.profile).toEqual({ frame: sketches[0]!.frame, loops: LOOPS })
    expect(p.path).toEqual({ frame: sketches[1]!.frame, loops: chain })
    expect(p.name).toBe('Handle')
    // a new body is a new part
    expect(add.mock.calls[0]![1]).toBe(0)
    // a finished profile with an inline path in space
    await run('geom.sweep', { design: 'd1', profile_sketch: 'k1', path: { points: [[0, 0, 5], [0, 20, 5]] }, operation: 'join', part: 0 })
    const q = add.mock.calls[1]![2] as Extract<StepParams, { op: 'sketch.sweep' }>
    expect(q.path).toEqual({ points: [[0, 0, 5], [0, 20, 5]] })
    expect(q.operation).toBe('join')
  })

  it('stores the parsed profile and path, not what was sent', async () => {
    const { add, run } = host()
    // a loop labeled a circle but drawn as segments is the segments; extra keys are dropped
    const square = { start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'line', to: [10, 10] }, { type: 'line', to: [0, 10] }, { type: 'line', to: [0, 0] }] }
    const chain = { start: [0, 0], segments: [{ type: 'line', to: [0, 20], extra: 1 }], note: 'x' }
    await run('geom.sweep', { design: 'd1', profile: { frame: { origin: [0, 0, 0], normal: [0, 0, 1], junk: true }, loops: [{ type: 'circle', ...square }] }, path: { frame: { origin: [0, 0, 0], normal: [0, -1, 0] }, loops: [chain] } })
    const p = add.mock.calls[0]![2] as Extract<StepParams, { op: 'sketch.sweep' }>
    expect(p.profile.loops).toEqual([square])
    expect(p.profile.frame).not.toHaveProperty('junk')
    expect(p.path.loops).toEqual([{ start: [0, 0], segments: [{ type: 'line', to: [0, 20] }] }])
  })

  it('stores the parsed loft and sweep options: smooth, closed, thicken, open profiles and landmarks', async () => {
    const { add, run } = host()
    const sq = (z: number, junk?: boolean) => ({ frame: { origin: [0, 0, z], normal: [0, 0, 1], ...(junk ? { junk } : {}) }, loops: [{ points: [[0, 0], [10, 0], [10, 10], [0, 10]], extra: 1 }], landmarks: [[0, 0], [10, 0], [10, 10]] })
    const quarter = (deg: number) => ({ frame: { origin: [20 * Math.cos((deg * Math.PI) / 180), 20 * Math.sin((deg * Math.PI) / 180), 0], normal: [-Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180), 0] }, open: true, loops: [{ points: [[-3, 0], [0, -3], [3, 0]] }] })
    await run('geom.loft', { design: 'd1', smooth: true, thicken: { thicknessMm: 1.5, note: 'x' }, profiles: [sq(0, true), sq(10)] })
    await run('geom.loft', { design: 'd1', closed: true, thicken: { thicknessMm: 1, side: 'inward' }, profiles: [quarter(0), quarter(120), quarter(240)] })
    await run('geom.sweep', { design: 'd1', profile: { open: true, loops: [{ points: [[0, 0], [10, 0]] }] }, path: { points: [[0, 0, 0], [0, 0, 20]] }, thicken: { thicknessMm: 2, side: 'center' } })
    const a = add.mock.calls[0]![2] as Extract<StepParams, { op: 'sketch.loft' }>
    const b = add.mock.calls[1]![2] as Extract<StepParams, { op: 'sketch.loft' }>
    expect(a.smooth).toBe(true)
    expect(a.closed).toBeUndefined()
    expect(a.thicken).toEqual({ thicknessMm: 1.5 })
    expect(a.profiles[0]!.landmarks).toEqual([[0, 0], [10, 0], [10, 10]])
    expect(a.profiles[0]!.frame).not.toHaveProperty('junk')
    expect(a.profiles[0]!.loops).toEqual([{ points: [[0, 0], [10, 0], [10, 10], [0, 10]] }])
    expect(a.profiles[0]).not.toHaveProperty('open')
    expect(b.closed).toBe(true)
    expect(b.thicken).toEqual({ thicknessMm: 1, side: 'inward' })
    expect(b.profiles.every((p) => p.open === true)).toBe(true)
    const c = add.mock.calls[2]![2] as Extract<StepParams, { op: 'sketch.sweep' }>
    expect(c.profile.open).toBe(true)
    expect(c.thicken).toEqual({ thicknessMm: 2, side: 'center' })
    // an open profile is one chain; a bad side or thickness is named by its field
    await expect(run('geom.loft', { design: 'd1', thicken: { thicknessMm: 1 }, profiles: [{ open: true, loops: [{ points: [[0, 0], [1, 0]] }, { points: [[0, 1], [1, 1]] }] }, sq(10)] })).rejects.toThrow(/^profiles\.0\.loops: /)
    await expect(run('geom.sweep', { design: 'd1', profile: { open: true, loops: [{ points: [[0, 0], [10, 0]] }] }, path: { points: [[0, 0, 0], [0, 0, 20]] }, thicken: { thicknessMm: 2, side: 'up' } })).rejects.toThrow(/^thicken\.side: /)
    expect(add).toHaveBeenCalledTimes(3)
    // up to 64 landmarks a profile
    const many = (n: number, z: number) => ({ ...sq(z), landmarks: Array.from({ length: n }, (_, i) => [(i * 10) / 64, 0]) })
    await run('geom.loft', { design: 'd1', profiles: [many(64, 0), many(64, 10)] })
    expect((add.mock.calls[3]![2] as Extract<StepParams, { op: 'sketch.loft' }>).profiles[0]!.landmarks).toHaveLength(64)
    await expect(run('geom.loft', { design: 'd1', profiles: [many(65, 0), many(65, 10)] })).rejects.toThrow(/^profiles\.0\.landmarks: /)
    expect(add).toHaveBeenCalledTimes(4)
  })

  it('says which sweep input is missing, doubled or needs a design', async () => {
    const { add, run } = host()
    await run('design.sketch', { loops: LOOPS })
    const path = { points: [[0, 0, 0], [0, 0, 10]] }
    const profile = { loops: LOOPS }
    await expect(run('geom.sweep', { design: 'd1', profile, profile_sketch: 'k1', path })).rejects.toThrow('profile_sketch: give profile or profile_sketch, not both')
    await expect(run('geom.sweep', { design: 'd1', path })).rejects.toThrow('profile: give the profile, or a finished sketch id as profile_sketch')
    await expect(run('geom.sweep', { design: 'd1', profile, path, path_sketch: 'k1' })).rejects.toThrow('path_sketch: give path or path_sketch, not both')
    await expect(run('geom.sweep', { design: 'd1', profile })).rejects.toThrow('path: give the path, or a finished sketch id as path_sketch')
    await expect(run('geom.sweep', { design: 'd1', profile, path: {} })).rejects.toThrow('path: give the path as loops on a plane or as points')
    await expect(run('geom.sweep', { design: 'd1', profile, path: { ...path, loops: [{ points: [[0, 0], [5, 0]] }] } })).rejects.toThrow('path: give loops or points, not both')
    await expect(run('geom.sweep', { profile_sketch: 'k1', path })).rejects.toThrow('profile_sketch: finished sketches sweep on a design; give its id as design')
    await expect(run('geom.sweep', { profile, path_sketch: 'k1' })).rejects.toThrow('path_sketch: finished sketches sweep on a design; give its id as design')
    // a bad field is named by its path, into the loop form it is closest to
    await expect(run('geom.sweep', { design: 'd1', profile: { frame: { origin: [0, 0] }, loops: LOOPS }, path })).rejects.toThrow(/^profile\.frame\.origin: /)
    await expect(run('geom.sweep', { design: 'd1', profile, path: { points: [[0, 0], [0, 10]] } })).rejects.toThrow(/^path\.points\.0: /)
    const bent = { start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'bend', to: [10, 10] }] }
    await expect(run('geom.sweep', { design: 'd1', profile: { loops: [bent] }, path })).rejects.toThrow(/^profile\.loops\.0\.segments\.1\.type: /)
    await expect(run('geom.sweep', { design: 'd1', profile, path: { loops: [{ start: [0, 0], segments: [{ type: 'line', to: [0, 'x'] }] }] } })).rejects.toThrow(/^path\.loops\.0\.segments\.0\.to\.1: /)
    expect(add).not.toHaveBeenCalled()
  })

  it('refuses a sketch with a shape, a sketch without a design, and a sketch on a host without a timeline', async () => {
    const { run } = host()
    await run('design.sketch', { loops: LOOPS })
    await expect(run('geom.extrude', { design: 'd1', sketch: 'k1', shape: { type: 'circle', diameterMm: 4 }, distance_mm: 4 })).rejects.toThrow(/leave shape and frame out/)
    await expect(run('geom.extrude', { sketch: 'k1', distance_mm: 4 })).rejects.toThrow(/give its id as design/)
    const plain = designToolset({ ...NO_ENGINE_HOST, get: () => ({}) as Design })
    const sk = plain.find((t) => t.name === 'design.sketch')!
    await expect(sk.run({ loops: LOOPS } as never, {} as never)).rejects.toThrow(/turn on the app link/)
  })

  it('solves the constraints first, keeps what the host settled, and reports driven dimensions', async () => {
    const moved = [{ type: 'circle' as const, center: [0, 0] as [number, number], diameterMm: 12 }]
    const settle = vi.fn(async (k: { loops: unknown[]; constraints: SketchConstraint[] }) => ({
      loops: moved,
      constraints: k.constraints.map((c, n) => (n === 1 ? ({ ...c, value: 12, driven: true } as SketchConstraint) : c)),
      status: 'redundant' as const,
      dof: 2,
    }))
    const { run, sketches } = host(settle)
    const cons = [
      { type: 'diameter', circle: { e: 0, seg: 0 }, value: 12, offset: 3 },
      { type: 'radius', circle: { e: 0, seg: 0 }, value: 7 },
    ]
    const made = await run('design.sketch', { loops: LOOPS, constraints: cons })
    expect(settle.mock.calls[0]![0]).toEqual({ loops: LOOPS, constraints: cons })
    expect(made.summary).toBe('Sketch 1 is in the timeline, 2 degrees of freedom left; dimensions [1] are driven')
    expect(made.output).toMatchObject({ dof: 2, driven: [1] })
    expect(sketches[0]!.loops).toEqual(moved)
    expect(sketches[0]!.constraints?.[1]).toMatchObject({ driven: true, value: 12 })
  })

  it('keeps splines as their points, counts them, and checks their shape', async () => {
    const loops = [
      { start: [0, 0], segments: [{ type: 'line', to: [20, 0] }, { type: 'spline', points: [[24, 8], [16, 14]], to: [0, 12] }, { type: 'line', to: [0, 0] }] },
      { type: 'spline', points: [[5, 3], [8, 4], [6, 7]] },
    ]
    const settle = vi.fn(async (k: { loops: unknown[]; constraints: SketchConstraint[] }) => ({ loops: k.loops as SketchItem['loops'], constraints: k.constraints, status: 'ok' as const, dof: 9 }))
    const check = vi.fn(async () => ({ ok: true, issues: [] }))
    const { run, sketches } = host(settle, check as unknown as DesignHost['call'])
    const made = await run('design.sketch', { loops })
    expect(check).toHaveBeenCalledWith('sketch.check', { loops })
    expect(made.summary).toBe('Sketch 1 is in the timeline, 2 splines')
    expect(sketches[0]!.loops).toEqual(loops)
    const cons = [{ type: 'fix', point: { e: 0, at: 'point', seg: 1, i: 0 } }, { type: 'distance', a: { e: 1, at: 'point', i: 0 }, b: { e: 1, at: 'point', i: 2 }, value: 4 }]
    const solved = await run('design.sketch', { loops, constraints: cons })
    expect(settle.mock.calls[0]![0]).toEqual({ loops, constraints: cons })
    expect(solved.summary).toBe('Sketch 2 is in the timeline, 2 splines, 9 degrees of freedom left')
    const input = designToolset({ ...NO_ENGINE_HOST, get: () => ({}) as Design }).find((t) => t.name === 'design.sketch')!.input
    expect(input.safeParse({ loops, constraints: cons }).success).toBe(true)
    await expect(run('design.sketch', { loops: [{ start: [0, 0], segments: [{ type: 'spline', points: [], to: [1, 1] }] }] })).rejects.toThrow(/needs 1 or more points/)
    await expect(run('design.sketch', { loops: [{ type: 'spline', points: [[0, 0], [1, 1]] }] })).rejects.toThrow(/3 or more points/)
    // a spline segment with no end never reaches the timeline, where the drawing could not read it
    await expect(run('design.sketch', { loops: [{ start: [0, 0], segments: [{ type: 'spline', points: [[5, 5], [10, 0]] }] }] })).rejects.toThrow(/needs its end as to/)
    // a spline point needs a whole i
    expect(input.safeParse({ loops, constraints: [{ type: 'fix', point: { e: 1, at: 'point' } }] }).success).toBe(false)
    expect(input.safeParse({ loops, constraints: [{ type: 'fix', point: { e: 1, at: 'point', i: 1.5 } }] }).success).toBe(false)
    expect(sketches).toHaveLength(2)
  })

  it('refuses a spline the engine cannot draw before it reaches the timeline', async () => {
    const message = 'Loop 1: spline segment 1 bends too sharply after its point 1 to draw within 0.005 mm; spread its points out.'
    const { run, sketches } = host(undefined, (async () => ({ ok: false, issues: [{ loop: 0, segment: 0, kind: 'tooDense', message }] })) as unknown as DesignHost['call'])
    const sharp = [{ start: [0, 0], segments: [{ type: 'spline', points: [[90000, 0]], to: [90000, 10] }, { type: 'line', to: [0, 0] }] }]
    await expect(run('design.sketch', { loops: sharp })).rejects.toThrow(/bends too sharply/)
    expect(sketches).toHaveLength(0)
  })

  it('reads each loop by the form its keys name, keeps only its fields, and names the field that is wrong', () => {
    const input = designToolset({ ...NO_ENGINE_HOST, get: () => ({}) as Design }).find((t) => t.name === 'design.sketch')!.input
    const issues = (v: unknown) => {
      const r = input.safeParse(v)
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    }
    const square = { start: [0, 0], segments: [{ type: 'line', to: [10, 0] }, { type: 'line', to: [10, 10] }, { type: 'line', to: [0, 0] }] }
    // a circle with a chain's fields is a circle missing its center, not a chain
    expect(issues({ loops: [{ type: 'circle', ...square }] }).join(' ')).toMatch(/^loops\.0\.center: /)
    expect(issues({ loops: [{ type: 'circle', points: [[0, 0], [1, 0], [0, 1]] }] }).join(' ')).toMatch(/loops\.0\.center/)
    expect(issues({ loops: [{ type: 'polygon', points: [[0, 0], [1, 0], [0, 1]] }] })).toEqual([expect.stringMatching(/^loops\.0: a loop is \{points\}/)])
    expect(issues({ loops: [square, square, { start: [0, 0], segments: [{ type: 'spline', points: [[1, 1]] }] }] })).toEqual(['loops.2.segments.0.to: a spline needs its end as to'])
    expect(issues({ loops: [square], frame: { origin: [0, 0, 0] } }).join(' ')).toMatch(/^frame\.normal: /)
    // what reaches the tool is the parsed loops, with stray fields dropped
    const r = input.safeParse({ loops: [{ ...square, stray: 1, segments: square.segments.map((g) => ({ ...g, extra: true })) }] })
    expect(r.success).toBe(true)
    expect((r.data as unknown as { loops: unknown }).loops).toEqual([square])
  })

  it('checks the solved loops too, and refuses a sketch past the point budget whichever loop tips it', async () => {
    const closed = { type: 'spline', points: [[0, 0], [10, 0], [10, 10], [0, 10]] }
    const merged = { type: 'spline', points: [[0, 0], [10, 0], [10, 0], [0, 10]] }
    const settle = vi.fn(async (k: { loops: unknown[]; constraints: SketchConstraint[] }) => ({ loops: [merged] as SketchItem['loops'], constraints: k.constraints, status: 'ok' as const, dof: 4 }))
    const check = vi.fn(async (_op: string, req: { loops: unknown[] }) =>
      JSON.stringify(req.loops) === JSON.stringify([merged]) ? { ok: false, issues: [{ loop: 0, kind: 'zeroLength', message: 'Loop 1: the spline has the same point twice in a row (point 3).' }] } : { ok: true, issues: [] },
    )
    const { run, sketches } = host(settle, check as unknown as DesignHost['call'])
    const cons = [{ type: 'coincident', a: { e: 0, at: 'point', i: 1 }, b: { e: 0, at: 'point', i: 2 } }]
    await expect(run('design.sketch', { loops: [closed], constraints: cons })).rejects.toThrow(/same point twice/)
    expect(check).toHaveBeenCalledTimes(2)
    expect(sketches).toHaveLength(0)
    const budget = 'The sketch has more than 262144 points once its curves are drawn, from loop 2 on.'
    const over = host(undefined, (async () => ({ ok: false, issues: [{ loop: 1, kind: 'tooDense', message: budget }] })) as unknown as DesignHost['call'])
    await expect(over.run('design.sketch', { loops: [closed, { points: [[20, 0], [30, 0], [25, 5]] }] })).rejects.toThrow(/262144 points/)
    expect(over.sketches).toHaveLength(0)
  })

  it('takes splines in every sketch tool, checked against the loops of slicerx_geom_revolve', () => {
    const tools = designToolset({ ...NO_ENGINE_HOST, get: () => ({}) as Design })
    const tool = (name: string) => tools.find((t) => t.name === name)!
    const seg = { start: [0, 0], segments: [{ type: 'spline', points: [[5, 5]], to: [10, 0] }, { type: 'line', to: [0, 0] }] }
    const closed = { type: 'spline', points: [[0, 0], [10, 0], [5, 8]] }
    const bad = { start: [0, 0], segments: [{ type: 'curve', to: [1, 1] }] }
    const inputs: [string, string, (l: unknown[]) => unknown][] = [
      ['geom.sketch_check', '1.1.0', (l) => ({ loops: l })],
      ['geom.sketch_edit', '1.1.0', (l) => ({ loops: l, op: 'intersect' })],
      ['geom.extrude', '1.3.0', (l) => ({ shape: { type: 'sketch', loops: l }, distance_mm: 2 })],
      ['geom.revolve', '1.3.0', (l) => ({ loops: l, axis: { point: [0, 0], direction: [0, 1] } })],
      ['design.sketch', '1.2.0', (l) => ({ loops: l })],
    ]
    for (const [name, version, input] of inputs) {
      expect(tool(name).version, name).toBe(version)
      expect(tool(name).input.safeParse(input([seg, closed])).success, name).toBe(true)
      expect(tool(name).input.safeParse(input([bad])).success, name).toBe(false)
    }
    expect(tool('geom.extrude').input.safeParse({ shape: { type: 'circle', diameterMm: 4 }, frame: { origin: [0, 0, 0] }, distance_mm: 2 }).success).toBe(false)
  })

  it('refuses constraints that conflict, and constraints on a host that cannot solve', async () => {
    const { run, sketches } = host(async (k) => ({ ...k, status: 'conflict', dof: 0 }))
    await expect(run('design.sketch', { loops: LOOPS, constraints: [{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 12 }] })).rejects.toThrow(/conflict/)
    expect(sketches).toHaveLength(0)
    const none = host()
    await expect(none.run('design.sketch', { loops: LOOPS, constraints: [{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 12 }] })).rejects.toThrow(/cannot solve/)
  })
})
