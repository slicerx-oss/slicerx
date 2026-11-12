// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// design.check once stopped reading the wall after 1.5 s of wall clock, so a recorded bottle replay read "part too
// dense" on a loaded runner and its check flipped to fail. The wall is read within counted work instead, for each part
// on its own, the same on every machine, in tests, replays and the app: a part copied (an arrayed detail) is read once,
// and a part out of work fails as not measured unless a wall under the floor was read already, which fails it anyway.
import { describe, expect, it } from 'vitest'
import { checkWallBudget, minWall, WALL_BUDGET } from '../src/body-facts'

type Tri = [[number, number, number], [number, number, number], [number, number, number]]

/** A closed box's twelve facets, facing out. */
function boxTris(lo: [number, number, number], hi: [number, number, number]): Tri[] {
  const [x0, y0, z0] = lo
  const [x1, y1, z1] = hi
  const p = (x: number, y: number, z: number): [number, number, number] => [x, y, z]
  const q = (a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): Tri[] => [[a, b, c], [a, c, d]]
  return [
    ...q(p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)),
    ...q(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)),
    ...q(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)),
    ...q(p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)),
    ...q(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)),
    ...q(p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)),
  ]
}

/** Facets as a mesh, each split into n by n smaller ones so a part has work to it. */
function meshOf(tris: Tri[], n = 1) {
  const positions: number[] = []
  const indices: number[] = []
  for (const [a, b, c] of tris)
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n - i; j++) {
        const at = (u: number, v: number) => [0, 1, 2].map((k) => a[k]! + ((b[k]! - a[k]!) * u + (c[k]! - a[k]!) * v) / n)
        const add = (...ps: number[][]) => {
          for (const pt of ps) {
            positions.push(...pt)
            indices.push(positions.length / 3 - 1)
          }
        }
        add(at(i, j), at(i + 1, j), at(i, j + 1))
        if (j < n - i - 1) add(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1))
      }
  return { positions, indices }
}

const shifted = (m: { positions: number[]; indices: number[] }, dx: number) => ({ positions: m.positions.map((v, i) => (i % 3 === 0 ? v + dx : v)), indices: m.indices })

describe('the wall budget design.check reads with', () => {
  it('is counted work, the same in tests, replays and the app', () => {
    expect(checkWallBudget()).toBe(WALL_BUDGET)
    expect(WALL_BUDGET).toEqual({ maxFacets: 1_000_000, maxWork: 60_000_000 })
  })

  it('reads a part copied along a row once, and the row reads the wall one part does', () => {
    const one = meshOf(boxTris([0, 0, 0], [10, 10, 1.2]), 6)
    const once = { work: 0 }
    expect(minWall([one], WALL_BUDGET, undefined, undefined, once)).toEqual({ mm: 1.2 })
    const row = { work: 0 }
    expect(minWall([0, 20, 40, 60, 80].map((dx) => shifted(one, dx)), WALL_BUDGET, undefined, undefined, row)).toEqual({ mm: 1.2 })
    expect(row.work).toBe(once.work)
    // a part that differs is read on its own, and its thinner wall wins
    const thin = meshOf(boxTris([100, 0, 0], [110, 10, 0.5]), 6)
    expect(minWall([one, shifted(one, 20), thin]).mm).toBe(0.5)
  })

  it('gives each part its own work, so parts that fit one at a time are all read', () => {
    const a = meshOf(boxTris([0, 0, 0], [10, 10, 2]), 6)
    const b = meshOf(boxTris([20, 0, 0], [35, 10, 3]), 6)
    const each = [{ work: 0 }, { work: 0 }]
    minWall([a], WALL_BUDGET, undefined, undefined, each[0])
    minWall([b], WALL_BUDGET, undefined, undefined, each[1])
    const most = Math.max(each[0]!.work, each[1]!.work)
    // a budget each part fits but the two together do not
    expect(each[0]!.work + each[1]!.work).toBeGreaterThan(most + 1)
    expect(minWall([a, b], { maxFacets: 1_000_000, maxWork: most + 1 })).toEqual({ mm: 2 })
  })

  it('out of work, fails as not measured, or on a wall under the floor it read already, never passing on less', () => {
    const thick = meshOf(boxTris([0, 0, 0], [10, 10, 3]), 8)
    // out of work with nothing under the floor read: not measured, which design.check fails
    expect(minWall([thick], { maxFacets: 1_000_000, maxWork: 500 })).toEqual({ mm: null, why: 'part too dense' })
    // a thin part read first, then a part out of work: the wall under the floor is the reading, and it fails the check
    const thin = meshOf(boxTris([20, 0, 0], [30, 10, 0.3]))
    const r = minWall([thin, thick], { maxFacets: 1_000_000, maxWork: 500 })
    expect(r.mm).toBe(0.3)
    // a part over the facet cap is not measured either
    expect(minWall([thick], { maxFacets: 10, maxWork: Infinity })).toEqual({ mm: null, why: 'part too dense' })
  })

  it('reads the same wall and the same work every run', () => {
    const m = meshOf(boxTris([0, 0, 0], [12, 8, 1.5]), 10)
    const a = { work: 0 }
    const b = { work: 0 }
    expect(minWall([m], WALL_BUDGET, undefined, undefined, a)).toEqual(minWall([m], WALL_BUDGET, undefined, undefined, b))
    expect(a.work).toBe(b.work)
    expect(a.work).toBeGreaterThan(0)
  })
})
