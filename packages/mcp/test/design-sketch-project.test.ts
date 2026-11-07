// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.sketch_project projects edges, a face or a body's outline into a finished sketch and reads back
// the curves; it switches a projection between reference and real, and removes one. The tool hands the host the
// source as the history keeps it (world mm at the body's transform, the face's key). Only a host with a timeline (the
// app) has finished sketches.
import { projectedOf, withProjection, withoutProjection, type Design, type DesignHost, type HistoryMesh, type ProjectMode, type ProjectSource, type SketchItem, type SketchLoop } from '@slicerx/cad-history'
import { describe, expect, it, vi } from 'vitest'
import { designToolset, NO_ENGINE_HOST } from '../src/toolset'

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const MOVED = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 50, 0, 0, 1]
const square = (w: number): SketchLoop => ({ start: [0, 0], segments: [{ type: 'line', to: [w, 0] }, { type: 'line', to: [w, w] }, { type: 'line', to: [0, w] }, { type: 'line', to: [0, 0] }] })

/** A 10 mm cube from the origin, its top face keyed 7. */
function cube(): HistoryMesh {
  const positions = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10]
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
  const ids = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  return { name: 'Cube', slot: 1, positions, indices, faces: { ids, table: [], keys: [3, 7, 11, 12, 13, 14] } }
}

function host(transform = I) {
  const d: Design = { id: 'd1', name: 'Cube', history: { version: 1, base: [], steps: [] }, transform, parts: [cube()], status: [], madeBy: {}, redo: [] }
  let k: SketchItem = { kind: 'sketch', id: 'k1', name: 'Sketch 1', loops: [] }
  const project = vi.fn(async (_id: string, source: ProjectSource, mode: ProjectMode) => {
    k = withProjection(k, { id: `p${(k.projections?.length ?? 0) + 1}`, source, mode }, [source.kind === 'edges' ? { start: [0, 0], segments: [{ type: 'line', to: [10, 0] }] } : square(10)])
    return { sketch: k, projection: k.projections!.at(-1)!.id, replayed: 1 }
  })
  const h: DesignHost = {
    ...NO_ENGINE_HOST,
    get: () => d,
    list: () => [d],
    sketch: () => k,
    project,
    changeProjection: async (_id, pid, change) => {
      const p = k.projections!.find((x) => x.id === pid)!
      k = 'remove' in change ? withoutProjection(k, pid) : withProjection(k, { ...p, mode: change.mode }, null)
      return { sketch: k, replayed: 0 }
    },
  }
  const tools = designToolset(h)
  const run = (input: Record<string, unknown>) => tools.find((t) => t.name === 'design.sketch_project')!.run(input as never, {} as never)
  return { run, project, sketch: () => k }
}

describe('design.sketch_project', () => {
  it('projects a face by its key and reads the curves back', async () => {
    const { run, project } = host()
    const out = await run({ sketch: 'k1', design: 'd1', kind: 'face', face: { at: [5, 5, 10], normal: [0, 0, 1] }, mode: 'real' })
    expect(project).toHaveBeenCalledWith('k1', { kind: 'face', body: 'd1', part: 0, transform: I, face: { at: [5, 5, 10], normal: [0, 0, 1], key: 7 } }, 'real')
    expect(out.summary).toBe('Projected the face outline of Cube into Sketch 1 as real curves: 4 lines; rebuilt the body drawn on it')
    expect(out.output).toEqual({ sketch: 'k1', name: 'Sketch 1', projection: 'p1', projections: [{ id: 'p1', kind: 'face', body: 'd1', part: 0, mode: 'real', loops: [square(10)] }], loops: 1, replayed: 1 })
  })

  it('keeps picked edges in world mm with the body’s transform, and a new projection is real', async () => {
    const { run, project, sketch } = host(MOVED)
    const edge = { a: [50, 0, 10], b: [60, 0, 10], face: [0, 0, 1], keys: [7, 13] }
    const out = await run({ sketch: 'k1', design: 'd1', kind: 'edges', edges: [edge] })
    expect(project.mock.calls[0]![1]).toEqual({ kind: 'edges', body: 'd1', part: 0, transform: MOVED, edges: [edge] })
    expect(project.mock.calls[0]![2]).toBe('real')
    expect(out.summary).toMatch(/^Projected an edge of Cube into Sketch 1 as real curves: 1 line/)
    expect(projectedOf(sketch().loops, 'p1')[0]).not.toHaveProperty('construction')
  })

  it('projects a body outline, switches it to reference and removes it', async () => {
    const { run, sketch } = host()
    await run({ sketch: 'k1', design: 'd1', kind: 'silhouette' })
    const off = await run({ sketch: 'k1', projection: 'p1', mode: 'reference' })
    expect(off.summary).toBe('p1 of Sketch 1 is now reference curves')
    expect(sketch().loops[0]).toMatchObject({ construction: true })
    const gone = await run({ sketch: 'k1', projection: 'p1', remove: true })
    expect(gone.summary).toBe('Removed p1 and its curves from Sketch 1')
    expect(gone.output).toMatchObject({ projections: [], loops: 0 })
  })

  it('refuses what it cannot do in plain words', async () => {
    const { run } = host()
    await expect(run({ sketch: 'k1', design: 'd1' })).rejects.toThrow('kind: edges, face or silhouette')
    await expect(run({ sketch: 'k1', kind: 'face', face: { at: [5, 5, 10] } })).rejects.toThrow('design: the body to project from')
    await expect(run({ sketch: 'k1', design: 'd1', kind: 'edges' })).rejects.toThrow(/^edges:/)
    await expect(run({ sketch: 'k1', design: 'd1', kind: 'silhouette', face: { at: [5, 5, 10] } })).rejects.toThrow('face: kind silhouette takes no face')
    await expect(run({ sketch: 'k1', projection: 'p1' })).rejects.toThrow(/^mode:/)
    await expect(run({ sketch: 'k1', projection: 'p1', mode: 'real', design: 'd1' })).rejects.toThrow(/^projection:/)
    await expect(run({ sketch: 'k1', remove: true })).rejects.toThrow('projection: name the projection to remove')
    // the server's own designs have no timeline
    const here = designToolset(NO_ENGINE_HOST).find((t) => t.name === 'design.sketch_project')!
    await expect(here.run({ sketch: 'k1', design: 'd1', kind: 'silhouette' } as never, {} as never)).rejects.toThrow(/turn on the app link/)
  })
})
