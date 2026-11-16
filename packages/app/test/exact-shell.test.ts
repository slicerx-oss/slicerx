// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A shell step in a replay with exact solids: it runs on the kernel (brep.shell) where the engine lists it, with its
// open faces in the part's own frame and their keys saved as found, and on the mesh shell, as before, where the engine
// does not. A shell the kernel cannot close runs on the mesh and says so. A design that must stay exact keeps its part
// exact through it. A stand-in exact engine.
import { beforeEach, describe, expect, it } from 'vitest'
import { clearReplayCache, EXACT_FELL_BACK, EXACT_MESH_FROM_HERE, IDENTITY, replayHistory, type History, type Step, type StepParams } from '@slicerx/cad-history'

type R = Record<string, unknown>
const tri = (mark: number) => ({ positions: [mark, 0, 0, 10, 0, 0, 0, 10, 0], indices: [0, 1, 2] })

/** Kernel ops answer a new body as text, a shell its open faces' keys too; the mesh ops answer a mesh. */
function engine(ops: string[], refuse = false) {
  const sent: { op: string; request: R }[] = []
  let n = 0
  const call = async (op: string, request: unknown) => {
    const req = request as R
    sent.push({ op, request: req })
    if (op === 'exact.ops') return { ops }
    if (op === 'brep.tessellate') return { ...tri(1), faceIds: [0], faces: [{ id: 0, type: 'plane', surface: { kind: 'plane', normal: [0, 0, 1], offset: 0 }, key: 77 }] }
    if (op === 'brep.shell') {
      // as the engine refuses a shell the kernel leaves open, such as a curved lofted body open at its top
      if (refuse) throw new Error('shell: a 1.5 mm wall could not be made exact on this body (shell: the result is not a solid: it is not closed)')
      return { bodySmb: `shell-${++n}`, openKeys: [77] }
    }
    if (op.startsWith('brep.')) return { bodySmb: `${op.slice(5)}-${++n}` }
    return { mesh: tri(2), removedVolumeMm3: 1, report: { touches: true, openKeys: [5] } }
  }
  return { call, sent, ops: () => sent.map((s) => s.op) }
}

const frame = { origin: [0, 0, 0], normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }
const step = (id: string, params: StepParams, transform = [...IDENTITY]): Step => ({ id, part: 0, transform, params })
const box = step('box', { op: 'shape.extrude', frame, shape: { type: 'rectangle', widthMm: 20, heightMm: 10 }, spec: { distanceMm: 5, operation: 'new' } } as StepParams)
// the part moved 10 mm along x where it sits, so the open face's point goes to the kernel 10 mm back
const moved = [...IDENTITY]
moved[12] = 10
const shell = (id: string) => step(id, { op: 'shell', open: [{ at: [10, 5, 5], normal: [0, 0, 1] }], wallMm: 1.5 } as StepParams, moved)

beforeEach(() => clearReplayCache())

describe('a shell on an exact part', () => {
  it('runs on the kernel where the engine has it, with its open faces in the part frame and their keys kept', async () => {
    const e = engine(['sketch.loft', 'brep.shell'])
    const history: History = { version: 1, base: [], steps: [box, shell('s')] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status.every((s) => s.state === 'done' && !s.note)).toBe(true)
    expect(r.exactFellBack).toBeUndefined()
    expect(e.ops()).toContain('brep.shell')
    expect(e.ops()).not.toContain('shell')
    const asked = e.sent.find((s) => s.op === 'brep.shell')!.request
    expect(asked['wallMm']).toBe(1.5)
    expect(asked['open']).toEqual([{ at: [0, 5, 5], normal: [0, 0, 1] }])
    expect(r.found?.['s']).toEqual({ openKeys: [77] })
  })

  it('keeps a design that must stay exact going through it', async () => {
    const e = engine(['sketch.loft', 'brep.shell'])
    const history: History = { version: 1, base: [], steps: [box, shell('s')], exact: true }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(r.status.every((s) => s.state === 'done')).toBe(true)
    expect(e.ops()).toContain('brep.shell')
  })

  it('runs on the mesh shell, as before, where the engine does not list it', async () => {
    const e = engine(['sketch.loft'])
    const history: History = { version: 1, base: [], steps: [box, shell('s')] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(e.ops()).not.toContain('brep.shell')
    expect(e.ops()).toContain('shell')
    expect(r.status[1]?.note).toBe(EXACT_MESH_FROM_HERE)
  })

  it('runs on the mesh shell with the fallback note where the kernel cannot close it', async () => {
    const e = engine(['sketch.loft', 'brep.shell'], true)
    const history: History = { version: 1, base: [], steps: [box, shell('s')] }
    const r = await replayHistory(e.call, { history, exact: true })
    expect(e.ops()).toContain('brep.shell')
    expect(e.ops()).toContain('shell')
    expect(r.status[1]).toMatchObject({ state: 'done', note: EXACT_FELL_BACK })
    expect(r.exactFellBack).toEqual(['s'])
  })
})
