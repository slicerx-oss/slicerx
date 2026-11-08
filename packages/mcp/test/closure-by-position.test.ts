// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Whether a part is closed, read the way the slicer welds it: corners at the same single-precision point are one
// vertex, whatever their indices. A sweep joined to a post once left a part whose triangle indices were closed while
// five tiny edges, welded, each had four triangles: geom.info and design.check said closed, the slicer saw a pinch.
import { bakeMesh, type Design as HostDesign, type DesignHost } from '@slicerx/cad-history'
import type { ToolContext } from '@slicerx/pilot'
import { describe, expect, it } from 'vitest'
import { bodyFacts } from '../src/body-facts'
import { cadTools, type CadFiles } from '../src/cad'
import { closureByPosition, partClosure } from '../src/closure'
import { createPlanRegistry, type PartPlan } from '../src/design-check'
import { designToolset } from '../src/toolset'
import { useGeomEngine } from './geom-engine'

type V3 = [number, number, number]
type Tri = [V3, V3, V3]

/** A closed box as 12 outward facing triangles. */
function boxTris([x0, y0, z0]: V3, [x1, y1, z1]: V3): Tri[] {
  const v = (i: number): V3 => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0]
  const f = (a: number, b: number, c: number): Tri => [v(a), v(b), v(c)]
  return [f(0, 1, 5), f(0, 2, 3), f(0, 5, 4), f(0, 3, 1), f(2, 6, 7), f(4, 5, 7), f(2, 7, 3), f(4, 7, 6), f(0, 4, 6), f(0, 6, 2), f(1, 3, 7), f(1, 7, 5)]
}

/** Triangles as an indexed mesh whose corners at one point share one index (within this list only). */
function indexed(tris: readonly Tri[]): { positions: number[]; indices: number[] } {
  const ids = new Map<string, number>()
  const positions: number[] = []
  const indices: number[] = []
  for (const t of tris)
    for (const p of t) {
      const key = p.join(',')
      let id = ids.get(key)
      if (id === undefined) {
        id = positions.length / 3
        ids.set(key, id)
        positions.push(...p)
      }
      indices.push(id)
    }
  return { positions, indices }
}

/** Two meshes as one part, the second's indices after the first's: nothing is shared between them by index. */
function side(a: { positions: number[]; indices: number[] }, b: { positions: number[]; indices: number[] }) {
  const n = a.positions.length / 3
  return { positions: [...a.positions, ...b.positions], indices: [...a.indices, ...b.indices.map((i) => i + n)] }
}

/**
 * The pinch: two boxes that touch along one edge (x = 10, y = 10), each closed by its own indices. The touching
 * corners are two vertices each at the same point, so by index every edge has two triangles; welded by position, the
 * shared edge has four.
 */
const pinch = () => side(indexed(boxTris([0, 0, 0], [10, 10, 10])), indexed(boxTris([10, 10, 0], [20, 20, 10])))

/** A closed box with no shared indices at all, every triangle its own three corners, as an STL stores it. */
const soupBox = () => {
  const tris = boxTris([0, 0, 0], [10, 10, 10])
  return { positions: tris.flat(2), indices: tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2]) }
}

describe('closureByPosition', () => {
  it('reads the pinch as not closed: one edge, welded, has four triangles', () => {
    expect(closureByPosition(pinch().positions, pinch().indices)).toEqual({ watertight: false, boundaryEdges: 0, nonManifoldEdges: 1, flippedEdges: 0 })
  })

  it('reads a closed box closed whether its corners are shared or repeated per triangle', () => {
    const closed = { watertight: true, boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 }
    const b = indexed(boxTris([0, 0, 0], [10, 10, 10]))
    expect(closureByPosition(b.positions, b.indices)).toEqual(closed)
    expect(closureByPosition(soupBox().positions, soupBox().indices)).toEqual(closed)
  })

  it('welds only corners the slicer welds: boxes a hair apart stay two closed boxes', () => {
    // the slicer merges bit-identical single-precision corners only, so faces 0.03 microns apart are not one face
    const m = side(indexed(boxTris([0, 0, 0], [10, 10, 10])), indexed(boxTris([10.00003, 0, 0], [20, 10, 10])))
    expect(closureByPosition(m.positions, m.indices).watertight).toBe(true)
    // the same box a hair past single precision is the same point, and the shared face then has four triangles on
    // each of its edges
    const same = side(indexed(boxTris([0, 0, 0], [10, 10, 10])), indexed(boxTris([10 + 1e-7, 0, 0], [20, 10, 10])))
    expect(closureByPosition(same.positions, same.indices)).toMatchObject({ watertight: false, nonManifoldEdges: 5 })
  })

  it('keeps -0 and 0 apart, as the slicer does, so a seam split across them reads open', () => {
    const b = soupBox()
    const positions = b.positions.map((c, k) => (k < 9 && c === 0 ? -0 : c))
    const c = closureByPosition(positions, b.indices)
    expect(c.watertight).toBe(false)
    expect(c.boundaryEdges).toBeGreaterThan(0)
  })

  it('counts open and flipped edges, and drops triangles whose corners weld together', () => {
    const b = indexed(boxTris([0, 0, 0], [10, 10, 10]))
    expect(closureByPosition(b.positions, b.indices.slice(3))).toMatchObject({ watertight: false, boundaryEdges: 3 })
    const flipped = [...b.indices]
    ;[flipped[0], flipped[1]] = [flipped[1]!, flipped[0]!]
    expect(closureByPosition(b.positions, flipped)).toMatchObject({ watertight: false, flippedEdges: 3 })
    // a sliver whose two corners are the same point adds nothing
    expect(closureByPosition([...b.positions, 0, 0, 0], [...b.indices, 0, 8, 1])).toEqual({ watertight: true, boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 })
    expect(closureByPosition([], []).watertight).toBe(false)
  })

  it('stays fast on a big mesh', () => {
    // a 400 x 400 grid on top and bottom of a slab: 640,000 triangles, corners repeated per triangle
    const n = 400
    const positions: number[] = []
    const quad = (a: V3, b: V3, c: V3, d: V3) => positions.push(...a, ...b, ...c, ...a, ...c, ...d)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        quad([i, j, 1], [i + 1, j, 1], [i + 1, j + 1, 1], [i, j + 1, 1])
        quad([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0])
      }
    const indices = Array.from({ length: positions.length / 3 }, (_, k) => k)
    const t = performance.now()
    const c = closureByPosition(positions, indices)
    const ms = performance.now() - t
    // open around the rim of each grid (the slab has no sides), closed everywhere else
    expect(c).toEqual({ watertight: false, boundaryEdges: 2 * 4 * n, nonManifoldEdges: 0, flippedEdges: 0 })
    expect(ms).toBeLessThan(3000)
  })
})

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const designOf = (id: string, mesh: { positions: number[]; indices: number[] }, transform: number[] = IDENTITY): HostDesign =>
  ({ id, name: 'Handle', history: { version: 1, base: [], steps: [] }, transform, parts: [{ name: 'Handle', slot: 0, ...mesh }], status: [], madeBy: {}, redo: [] }) as unknown as HostDesign

const geom = useGeomEngine('closure-by-position-replies')

/** A host of these designs whose engine is the real one. */
const hostOf = (all: HostDesign[]): DesignHost =>
  ({
    get: (id: string) => {
      const d = all.find((x) => x.id === id)
      if (!d) throw new Error(`no design ${id}`)
      return d
    },
    list: () => all,
    create: async () => Promise.reject(new Error('not here')),
    add: async () => Promise.reject(new Error('not here')),
    replay: async () => {},
    call: (op: string, request: unknown) => geom.engine(op, request),
  }) as unknown as DesignHost

const files: CadFiles = { engine: false, call: async () => Promise.reject(new Error('no files here')), path: async (m) => m, stl: () => new Float32Array() }

async function info(d: HostDesign) {
  const tool = cadTools({ files, designs: hostOf([d]) }).find((t) => t.name === 'geom.info')!
  const r = await tool.run(tool.input.parse({ design: d.id }) as never, {} as ToolContext)
  return r as { summary: string; output: { parts: { watertight: boolean; edges: { boundaryEdges: number; nonManifoldEdges: number; flippedEdges: number } }[] } }
}

describe('geom.info on a design', () => {
  it('reads the pinch as not closed, and says why', async () => {
    const r = await info(designOf('d1', pinch()))
    expect(r.output.parts[0]).toMatchObject({ watertight: false, edges: { boundaryEdges: 0, nonManifoldEdges: 1, flippedEdges: 0 } })
    expect(r.summary).toBe('1 part, not closed (1 edge where more than two faces meet)')
  })

  it('reads a closed box closed though no two triangles share an index', async () => {
    const r = await info(designOf('d2', soupBox()))
    expect(r.output.parts[0]).toMatchObject({ watertight: true, edges: { boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 } })
    expect(r.summary).toBe('1 part, closed')
  })
})

describe('design.check on the pinch', () => {
  it('fails the watertight item with a plain reason', async () => {
    const plans = createPlanRegistry()
    const plan: PartPlan = { planId: 'handle-1', part: 'Handle', units: 'mm', features: [], overall: { x: 20, y: 20, z: 10 }, assumptions: [], questions: [] }
    plans.put(plan)
    plans.tie('handle-1', 'd1')
    const tool = designToolset(hostOf([designOf('d1', pinch())]), {}, { plans }).find((t) => t.name === 'design.check')!
    const r = await tool.run(tool.input.parse({ planId: 'handle-1' }), {} as ToolContext)
    const out = r.output as { pass: boolean; items: { name: string; want: string; got: string; pass: boolean }[] }
    expect(out.pass).toBe(false)
    expect(out.items.filter((i) => !i.pass).map((i) => i.name)).toEqual(['watertight'])
    expect(out.items.find((i) => i.name === 'watertight')).toEqual({
      name: 'watertight',
      want: 'closed',
      got: 'open: 1 edge where more than two faces meet (surfaces that touch without joining, which repair leaves as they are); rebuild that join so the shapes overlap a little',
      pass: false,
    })
  })
})

describe('repair on the pinch', () => {
  // The watertight item tells mimir to rebuild the join rather than repair it: repair welds the touching corners and
  // the edge keeps its four triangles, so a repair step would leave the part as open as before.
  it('leaves the touching edge with four triangles', async () => {
    const r = (await geom.engine('repair', { mesh: pinch(), options: {} })) as { mesh: { positions: number[]; indices: number[] }; report: { watertight: boolean; nonManifoldEdges: number } }
    expect(r.report).toMatchObject({ watertight: false, nonManifoldEdges: 1 })
    expect(closureByPosition(r.mesh.positions, r.mesh.indices)).toMatchObject({ watertight: false, nonManifoldEdges: 1 })
  })
})

/** The next single-precision number above x. */
const nextUp = (x: number): number => {
  const f = new Float32Array([x])
  const bits = new Uint32Array(f.buffer)
  bits[0] = bits[0]! + (x >= 0 ? 1 : -1)
  return f[0]!
}

/**
 * A closed box from lo to hi whose first triangle takes its second corner from a copy of that vertex moved to x: the
 * copy at another single-precision point leaves the triangle's two edges at that corner open.
 */
function splitCorner(lo: V3, hi: V3, x: number) {
  const b = indexed(boxTris(lo, hi))
  const v = b.indices[1]!
  const copy = b.positions.length / 3
  b.positions.push(x, b.positions[v * 3 + 1]!, b.positions[v * 3 + 2]!)
  b.indices[1] = copy
  return b
}

const moved = (dx: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, dx, 0, 0, 1]

describe('closure read on the part before its transform', () => {
  it('keeps corners one ulp apart on the part apart wherever the part sits on the bed', async () => {
    // the box's corner at x = 20 and a copy one ulp above it: two points on the part, as the slicer welds it
    const b = splitCorner([10, 0, 0], [20, 10, 10], nextUp(20))
    expect(b.positions.at(-3)).not.toBe(20)
    // moved to x = 170 the two round to one single-precision point, so reading the moved mesh would call it closed
    expect(closureByPosition(bakeMesh({ name: 'Box', slot: 0, ...b }, moved(150)).positions, b.indices).watertight).toBe(true)
    for (const transform of [IDENTITY, moved(150)]) {
      const r = await info(designOf('d3', b, transform))
      expect(r.output.parts[0]).toMatchObject({ watertight: false, edges: { boundaryEdges: 4, nonManifoldEdges: 0, flippedEdges: 0 } })
    }
  })

  it('gives design.check the same reading for a part moved on the bed', async () => {
    const d = designOf('d7', splitCorner([10, 0, 0], [20, 10, 10], nextUp(20)), moved(150))
    expect(await bodyFacts(hostOf([d]), d)).toMatchObject({ watertight: false, openWhy: '4 open edges' })
  })

  it('keeps -0 apart from 0 through geom.info', async () => {
    const b = splitCorner([0, 0, 0], [10, 10, 10], -0)
    // the corner the copy stands for is at x = 0
    expect(Object.is(b.positions.at(-3), -0)).toBe(true)
    const r = await info(designOf('d4', b))
    expect(r.output.parts[0]).toMatchObject({ watertight: false, edges: { boundaryEdges: 4 } })
  })

  it('reads a mirrored part as it reads the part', async () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect((await info(designOf('d5', pinch(), mirror))).output.parts[0]).toMatchObject({ watertight: false, edges: { boundaryEdges: 0, nonManifoldEdges: 1, flippedEdges: 0 } })
    expect((await info(designOf('d6', soupBox(), mirror))).output.parts[0]).toMatchObject({ watertight: true, edges: { boundaryEdges: 0, nonManifoldEdges: 0, flippedEdges: 0 } })
  })

  it('reads an unchanged part once', () => {
    const part = pinch()
    const first = partClosure(part)
    expect(partClosure(part)).toBe(first)
    // a step replaces the part's arrays; the new mesh is read again
    expect(partClosure({ positions: part.positions, indices: [...part.indices] })).not.toBe(first)
  })
})
