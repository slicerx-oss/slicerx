// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A plate's own layer heights: the printer's limits, the curve, the tops a slice gets from it, and the profile made
// from sleipnir's plan that the editor starts from.
import { describe, expect, it } from 'vitest'
import { cleanProfile, flatProfile, heightAt, layerLimits, plateProfileFromFile, profileFromTops, profileTops, type ProfilePoint } from '../src/plate/layer-profile'
import { boxMesh } from '../src/plate/mesh-ops'
import { compose } from '../src/plate/transform'

const LIMITS = { minMm: 0.08, maxMm: 0.28, firstMm: 0.2 }
const thick = (tops: number[]) => tops.map((t, i) => Number((t - (i ? tops[i - 1]! : 0)).toFixed(4)))

describe("the printer's limits", () => {
  it('reads min and max layer height and the first layer from the resolved config', () => {
    expect(layerLimits({ nozzle_diameter: [0.4], min_layer_height: [0.08], max_layer_height: [0.28], initial_layer_print_height: 0.2 })).toEqual(LIMITS)
  })

  it('falls back to 0.07 mm and three quarters of the nozzle when the printer leaves them at 0', () => {
    expect(layerLimits({ nozzle_diameter: [0.6], min_layer_height: [0], max_layer_height: [0], initial_layer_print_height: 0.3 })).toEqual({ minMm: 0.07, maxMm: 0.45, firstMm: 0.3 })
  })

  it('take the strictest of several extruders: the largest minimum, the smallest maximum, each from its own nozzle', () => {
    expect(layerLimits({ nozzle_diameter: [0.4, 0.4], min_layer_height: [0.08, 0.12], max_layer_height: [0.28, 0.2], initial_layer_print_height: 0.2 })).toEqual({ minMm: 0.12, maxMm: 0.2, firstMm: 0.2 })
    // A 0.4 and a 0.2 nozzle with no maximum set: three quarters of the smaller, 0.15 mm.
    expect(layerLimits({ nozzle_diameter: [0.4, 0.2], min_layer_height: [0, 0], max_layer_height: [0, 0], initial_layer_print_height: 0.2 })).toEqual({ minMm: 0.07, maxMm: 0.15, firstMm: 0.2 })
    // One entry for two nozzles reads for both; a maximum under the minimum is raised to it.
    expect(layerLimits({ nozzle_diameter: [0.4, 0.2], min_layer_height: [0.1], max_layer_height: [0], initial_layer_print_height: 0.2 })).toEqual({ minMm: 0.1, maxMm: 0.15, firstMm: 0.2 })
    expect(layerLimits({ nozzle_diameter: [0.4, 0.4], min_layer_height: [0.08, 0.2], max_layer_height: [0.28, 0.12], initial_layer_print_height: 0.2 })).toEqual({ minMm: 0.2, maxMm: 0.2, firstMm: 0.2 })
  })

  it('keeps them inside what the engine takes, and starts over a raft at the layer height', () => {
    expect(layerLimits({ nozzle_diameter: [1.8], min_layer_height: [0.01], max_layer_height: [2], layer_height: 0.3, raft_layers: 2, initial_layer_print_height: 0.5 })).toEqual({ minMm: 0.04, maxMm: 0.8, firstMm: 0.3 })
  })
})

describe('the curve', () => {
  const pts: ProfilePoint[] = [[2, 0.1], [6, 0.3]]
  it('is straight between points and flat past the ends', () => {
    expect(heightAt(pts, 0)).toBe(0.1)
    expect(heightAt(pts, 4)).toBeCloseTo(0.2, 9)
    expect(heightAt(pts, 9)).toBe(0.3)
  })

  it('is cleaned: sorted, finite, one point per height, heights inside the limits', () => {
    const got = cleanProfile([[5, 0.5], [1, 0.12], [1, 0.16], [Number.NaN, 0.1], [-1, 0.1], [3, 0.01]], LIMITS)
    expect(got).toEqual({ points: [[1, 0.16], [3, 0.08], [5, 0.28]], clamped: true, dropped: true })
    expect(cleanProfile([[1, 0.12]], LIMITS)).toEqual({ points: [[1, 0.12]], clamped: false, dropped: false })
    expect(cleanProfile([], LIMITS)).toBeNull()
  })
})

describe('a long profile from a file', () => {
  // One pair a layer, as other slicers save: 0.2 mm all the way to 300 mm, a 2 mm band at 0.08 mm at 101 mm and a
  // slope from 200 to 250 mm, 3000 pairs.
  const dense: ProfilePoint[] = []
  for (let i = 0; i < 3000; i++) {
    const z = Number((i * 0.1).toFixed(4))
    const h = z >= 101 && z < 103 ? 0.08 : z >= 200 && z < 250 ? Number((0.2 - ((z - 200) / 50) * 0.1).toFixed(4)) : z >= 250 ? 0.1 : 0.2
    dense.push([z, h])
  }

  it('keeps at most 200 points, its ends, and its shape: steps and slopes, not every Nth point', () => {
    const got = cleanProfile(dense, LIMITS)!
    expect(got.points.length).toBeLessThanOrEqual(200)
    expect(got.dropped).toBe(true)
    expect(got.points[0]).toEqual(dense[0])
    expect(got.points[got.points.length - 1]).toEqual(dense[dense.length - 1])
    // Every height of the file's curve is where it was, to a micron, the short band included.
    for (const [z, h] of dense) expect(Math.abs(heightAt(got.points, z) - h)).toBeLessThanOrEqual(0.001)
  })
})

/** The engine's check on given tops (LayerPlan::from_tops in packages/core/src/layers.rs), step for step. */
function engineAccepts(maxZ: number, tops: readonly number[]): string | null {
  let bottom = 0
  let sliced = 0
  for (const [i, top] of tops.entries()) {
    if (!Number.isFinite(top)) return `entry ${i} is not a number`
    const t = top - bottom
    if (t < 0.04 - 1e-9 || t > 0.8 + 1e-9) return `layer ${i} is ${t.toFixed(4)} mm thick`
    if ((bottom + top) / 2 >= maxZ) return null
    sliced++
    bottom = top
  }
  return sliced === tops.length && bottom < maxZ - 1e-3 ? `tops end at ${bottom.toFixed(4)} mm, below ${maxZ}` : null
}

describe("the tops, against the engine's rules", () => {
  const limitsOf = (minMm: number, maxMm: number, firstMm: number) => ({ minMm, maxMm, firstMm })
  const curves: ProfilePoint[][] = [[[0, 0.1]], [[0, 0.28]], [[0, 0.08], [2, 0.28]], [[0, 0.3], [1, 0.05], [3, 0.4]], [[0.2, 0.12], [50, 0.24], [120, 0.08], [300, 0.2]]]
  const limitSets = [LIMITS, limitsOf(0.15, 0.25, 0.2), limitsOf(0.04, 0.8, 0.3), limitsOf(0.1, 0.12, 0.25), limitsOf(0.08, 0.28, 0.3)]
  const heights = [0.1, 0.2, 0.21, 0.22, 0.24, 0.27, 0.28, 0.3, 0.33, 0.45, 1, 1.03, 1.05, 7.77, 300]

  it('are taken by the engine for every curve, set of limits and plate height, each layer inside the limits', () => {
    for (const curve of curves) {
      for (const lim of limitSets) {
        for (const top of heights) {
          const tops = profileTops(curve, top, lim)
          expect(engineAccepts(top, tops), `${JSON.stringify(curve)} ${JSON.stringify(lim)} top ${top}`).toBeNull()
          const t = thick(tops)
          expect(t[0]).toBe(lim.firstMm)
          for (const h of t.slice(1)) {
            expect(h).toBeGreaterThanOrEqual(lim.minMm - 1e-9)
            expect(h).toBeLessThanOrEqual(lim.maxMm + 1e-9)
          }
        }
      }
    }
  })

  it('print a plate no taller than the first layer as that one layer', () => {
    expect(profileTops([[0, 0.1]], 0.15, LIMITS)).toEqual([0.2])
    expect(profileTops([[0, 0.1]], 0.2, LIMITS)).toEqual([0.2])
  })

  it('give a plate just over the first layer a last layer of the minimum, not a 0.02 mm sliver', () => {
    expect(profileTops([[0, 0.1]], 0.22, LIMITS)).toEqual([0.2, 0.28])
  })

  it('give a last sliver to two layers that both stay inside a narrow range, or one layer of the minimum', () => {
    // 0.15 to 0.25 mm: 0.15 + 0.14 left would be two layers of 0.145, under the minimum, so the last is 0.15 thick.
    const tops = profileTops([[0, 0.15]], 0.2 + 0.15 * 4 + 0.14, limitsOf(0.15, 0.25, 0.2))
    expect(thick(tops).slice(1)).toEqual([0.15, 0.15, 0.15, 0.15, 0.15])
    expect(engineAccepts(0.94, tops)).toBeNull()
  })

  it('reach a 300 mm plate in the layers the curve gives, without drift', () => {
    const tops = profileTops([[0, 0.2]], 300, LIMITS)
    expect(tops.length).toBe(1500)
    expect(tops[tops.length - 1]).toBe(300)
    expect(thick(tops).slice(1).every((t) => t === 0.2)).toBe(true)
  })

  it('start over a raft at the layer height, as the engine plans the part over it', () => {
    const lim = layerLimits({ nozzle_diameter: [0.4], min_layer_height: [0.08], max_layer_height: [0.28], layer_height: 0.16, raft_layers: 3, initial_layer_print_height: 0.3 })
    const tops = profileTops([[0, 0.12]], 5, lim)
    expect(tops[0]).toBe(0.16)
    expect(engineAccepts(5, tops)).toBeNull()
  })
})

describe('the tops a profile slices at', () => {
  it('start at the first layer height, follow the curve, and reach the top of the plate', () => {
    const tops = profileTops([[0, 0.1], [10, 0.1]], 1, LIMITS)
    expect(tops[0]).toBe(0.2)
    expect(thick(tops).slice(1).every((t) => Math.abs(t - 0.1) < 1e-9)).toBe(true)
    expect(tops[tops.length - 1]).toBe(1)
    expect(tops[tops.length - 2]).toBeLessThan(1)
  })

  it('end on the top of the plate, a last sliver joining the layer below or sharing its height', () => {
    // 0.25 mm left over a 0.2 mm curve: the last layer is 0.05, under the minimum, and joins the one below.
    const joined = profileTops([[0, 0.2]], 1.05, LIMITS)
    expect(joined[joined.length - 1]).toBe(1.05)
    expect(thick(joined).slice(-2)).toEqual([0.2, 0.25])
    // At 0.26 mm layers a 0.05 sliver would make one layer of 0.31, past the maximum, so the two share it.
    const shared = profileTops([[0, 0.26]], 1.03, LIMITS)
    expect(shared[shared.length - 1]).toBe(1.03)
    expect(thick(shared).slice(-2)).toEqual([0.155, 0.155])
    // A last layer at or over the minimum stays as it is.
    expect(thick(profileTops([[0, 0.2]], 1.1, LIMITS)).slice(-1)).toEqual([0.1])
  })

  it('thicken where the curve rises, and every layer stays inside the limits', () => {
    const tops = profileTops([[1, 0.08], [5, 0.28]], 6, LIMITS)
    const t = thick(tops).slice(1)
    for (const h of t) {
      expect(h).toBeGreaterThanOrEqual(0.08 - 1e-9)
      expect(h).toBeLessThanOrEqual(0.28 + 1e-9)
    }
    expect(t[0]).toBe(0.08)
    expect(Math.max(...t)).toBe(0.28)
    // The last two may share what is left under the top; below them the layers only thicken.
    for (let i = 1; i < t.length - 2; i++) expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]! - 1e-9)
  })

  it('clamp a curve outside the limits instead of passing it on', () => {
    const t = thick(profileTops([[0, 0.01], [10, 2]], 10, LIMITS)).slice(1)
    expect(Math.min(...t)).toBe(0.08)
    expect(Math.max(...t)).toBe(0.28)
  })

  it('are a flat curve when the profile is flat', () => {
    expect(profileTops(flatProfile(0.2, 2, LIMITS), 2, LIMITS)).toEqual([0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8, 2])
  })
})

describe('a profile from a plan', () => {
  it('keeps the bends and drops the points on a straight run, with the first layer left out', () => {
    const tops = [0.2]
    for (let i = 0; i < 20; i++) tops.push(Number((tops[i]! + 0.1).toFixed(4)))
    for (let i = 0; i < 20; i++) tops.push(Number((tops[tops.length - 1]! + 0.2).toFixed(4)))
    const pts = profileFromTops(tops)
    expect(pts[0]).toEqual([0.2, 0.1])
    expect(pts[pts.length - 1]![1]).toBe(0.2)
    expect(pts.length).toBeLessThanOrEqual(5)
    // The tops it gives back are the plan's own.
    expect(profileTops(pts, tops[tops.length - 1]!, LIMITS)).toEqual(tops)
  })

  it('holds at most the points asked for', () => {
    const tops = [0.2]
    for (let i = 0; i < 300; i++) tops.push(Number((tops[i]! + (i % 2 ? 0.1 : 0.25)).toFixed(4)))
    expect(profileFromTops(tops, 24).length).toBeLessThanOrEqual(24)
  })
})

describe("a plate's profile from a project file's objects", () => {
  const box = (z: number, h: number) => ({ parts: [{ ...boxMesh(10, 10, h), name: 'Body', slot: 1 }], transform: compose({ position: [50, 50, z], rotation: [0, 0, 0], scale: [1, 1, 1] }) })

  it('moves each object profile up by where its bottom sits', () => {
    const got = plateProfileFromFile([{ name: 'a', points: [[0, 0.12], [4, 0.2]], entry: box(1, 4) }], LIMITS)
    expect(got).toEqual({ points: [[1, 0.12], [5, 0.2]], clamped: false })
  })

  it("uses the tallest object's when the objects' profiles differ, and names it", () => {
    const got = plateProfileFromFile([{ name: 'short', points: [[0, 0.12], [4, 0.12]], entry: box(0, 4) }, { name: 'tall', points: [[0, 0.2], [9, 0.2]], entry: box(0, 9) }, { name: 'none', entry: box(0, 2) }], LIMITS)
    expect(got).toEqual({ points: [[0, 0.2], [9, 0.2]], clamped: false, from: 'tall' })
  })

  it("reads a saved plate's curve, cut at each object's own height, as one curve", () => {
    // What the app writes for a plate with a 10 mm and a 6 mm object: the short one's ends at 6 mm.
    const got = plateProfileFromFile([{ name: 'tall', points: [[0, 0.12], [0.2, 0.12], [4, 0.12], [8, 0.24], [10, 0.24]], entry: box(0, 10) }, { name: 'short', points: [[0, 0.12], [0.2, 0.12], [4, 0.12], [6, 0.18]], entry: box(0, 6) }], LIMITS)
    expect(got).toEqual({ points: [[0, 0.12], [0.2, 0.12], [4, 0.12], [8, 0.24], [10, 0.24]], clamped: false })
    // Flat, as well, and whichever object comes first.
    expect(plateProfileFromFile([{ name: 'short', points: [[0, 0.2], [3, 0.2]], entry: box(0, 3) }, { name: 'tall', points: [[0, 0.2], [9, 0.2]], entry: box(0, 9) }], LIMITS)).toEqual({ points: [[0, 0.2], [9, 0.2]], clamped: false })
  })

  it('says when points were left out', () => {
    expect(plateProfileFromFile([{ name: 'a', points: [[0, 0.2], [Number.NaN, 0.1], [4, 0.2]], entry: box(0, 4) }], LIMITS)).toEqual({ points: [[0, 0.2], [4, 0.2]], clamped: false, dropped: true })
  })

  it('keeps heights the printer does not print inside its limits and says so', () => {
    expect(plateProfileFromFile([{ name: 'a', points: [[0, 0.02], [4, 0.6]], entry: box(0, 4) }], LIMITS)).toEqual({ points: [[0, 0.08], [4, 0.28]], clamped: true })
    expect(plateProfileFromFile([{ name: 'a', entry: box(0, 4) }], LIMITS)).toBeNull()
  })
})
