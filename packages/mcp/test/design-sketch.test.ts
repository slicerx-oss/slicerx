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

function host(settle?: DesignHost['settleSketch']) {
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

  it('refuses constraints that conflict, and constraints on a host that cannot solve', async () => {
    const { run, sketches } = host(async (k) => ({ ...k, status: 'conflict', dof: 0 }))
    await expect(run('design.sketch', { loops: LOOPS, constraints: [{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 12 }] })).rejects.toThrow(/conflict/)
    expect(sketches).toHaveLength(0)
    const none = host()
    await expect(none.run('design.sketch', { loops: LOOPS, constraints: [{ type: 'diameter', circle: { e: 0, seg: 0 }, value: 12 }] })).rejects.toThrow(/cannot solve/)
  })
})
