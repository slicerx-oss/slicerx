// @vitest-environment node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The mimir tab's answer to a step reads the status of the replay that just ran, as the server's designs do: a row of
// holes where a copy misses the part answers which copy was left out, in the summary and as copies; a plain step
// answers as before. A stand-in mesh engine, where a cut misses for the copy the test names.
import type { MeshHandle, MeshPart } from '@slicerx/contracts'
import { clearReplayCache } from '@slicerx/cad-history'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setGeomProvider } from '../src/geom/client'
import { get, set } from '../src/state/store'
import { toolsFor } from '../src/workspaces/mimir/session'

type R = Record<string, unknown>
/** A closed box from `min` to `max`. */
function box(min: number[], max: number[]) {
  const [a, b] = [min, max] as [number[], number[]]
  const positions = [a[0], a[1], a[2], b[0], a[1], a[2], b[0], b[1], a[2], a[0], b[1], a[2], a[0], a[1], b[2], b[0], a[1], b[2], b[0], b[1], b[2], a[0], b[1], b[2]] as number[]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  return { positions, indices }
}
const BODY = box([-20, -10, 0], [20, 10, 5])
const handle = (id: string): MeshHandle => ({ id, hash: id, name: id, triangles: 12, bboxMm: [40, 20, 5], openEdges: 0, parts: [] })
const loader = { loadParts: async (name: string, _parts: MeshPart[]) => handle(name) }

/**
 * Every cut misses (removes nothing) where `misses` says so for how far the request's part moved from where the first
 * cut had it (the design stands where it landed on the bed); everything else makes the body.
 */
function engine(misses: (x: number) => boolean) {
  let first: number | undefined
  return {
    call: async <T>(op: string, request: unknown): Promise<T> => {
      const req = request as R
      const item = (req['mesh'] ?? req['target']) as { transform?: number[] } | undefined
      const x = item?.transform?.[12] ?? 0
      if (op === 'subtract') return { mesh: BODY, removedVolumeMm3: misses(x - (first ??= x)) ? 0 : 5 } as T
      if (op === 'shape.extrude') return { mesh: BODY, report: { touches: true } } as T
      throw new Error(`unexpected ${op}`)
    },
  }
}

const tools = () => toolsFor(loader)
async function run(name: string, args: R) {
  const t = tools().find((x) => x.name === name)!
  return (await t.run(t.input.parse(args) as never, {} as never)) as { ok?: boolean; summary: string; output: R }
}

beforeEach(() => {
  clearReplayCache()
  set({ plate: [], selection: null, selectedIds: [], historyEdit: null, bed: { widthMm: 256, depthMm: 256, heightMm: 256 } })
})
afterEach(() => setGeomProvider(null))

describe('a step answered in the mimir tab', () => {
  it('answers which copy of a row was left out, in its summary and as copies', async () => {
    // copy k of a row 12 mm apart moves the part back by 12 (k - 1) mm: copy 3 misses
    setGeomProvider(engine((x) => Math.round(-x / 12) + 1 === 3))
    const made = await run('design.new', { name: 'Bar' })
    const design = (made.output as { design: string }).design
    await run('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5, name: 'Bar' })
    const hole = await run('geom.subtract', { design, part: 0, solids: [{ type: 'cylinder', origin: [-12, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole' })
    // a plain step answers as it did
    expect(hole.summary).not.toMatch(/left out/)
    expect(hole.output).not.toHaveProperty('copies')
    const r = await run('geom.array', { design, steps: [2], spec: { kind: 'linear', count: 3, step: [12, 0, 0] } })
    expect(r.ok).not.toBe(false)
    expect(r.summary).toMatch(/^Patterned 1 step, 3 copies.*\. Copy 3 did not reach the part and was left out$/)
    expect(r.output['copies']).toEqual({ total: 3, kept: 2, missed: [3] })
    expect(get().plate.find((p) => p.id === design)?.history?.steps.at(-1)?.note).toBe('Copy 3 did not reach the part and was left out.')
  })

  it('answers a row where every copy lands with its copies and no note', async () => {
    setGeomProvider(engine(() => false))
    const design = ((await run('design.new', { name: 'Bar' })).output as { design: string }).design
    await run('geom.extrude', { design, shape: { type: 'rectangle', widthMm: 40, heightMm: 20 }, distance_mm: 5, name: 'Bar' })
    await run('geom.subtract', { design, part: 0, solids: [{ type: 'cylinder', origin: [-12, 0, 0], axis: [0, 0, 1], diameterMm: 4, heightMm: 5 }], label: 'Hole' })
    const r = await run('geom.array', { design, steps: [2], spec: { kind: 'linear', count: 3, step: [12, 0, 0] } })
    expect(r.summary).not.toMatch(/left out/)
    expect(r.output['copies']).toEqual({ total: 3, kept: 3, missed: [] })
  })
})
